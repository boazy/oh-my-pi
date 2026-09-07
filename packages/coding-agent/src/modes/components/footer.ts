import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { shortenPath } from "../../tools/render-utils";
import { sanitizeStatusText } from "../shared";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "./status-line/context-thresholds";

/** Minimum interval between display-backend syncs (re-discovery walks). */
const FOOTER_DISPLAY_SYNC_TTL_MS = 5000;

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent implements Component {
	#cachedBranch: string | null | undefined = undefined;
	#branchResolve: AbortController | undefined;
	#branchGeneration = 0;
	#gitUnwatch: (() => void) | null = null;

	// Watch target the installed watcher follows; when the display backend
	// changes under it (late colocation), the watcher is rebound.
	#watchedTarget: string | null = null;

	// Fallback watcher for a retired jj display: while the cached branch
	// comes from the operational git repo, this follows its HEAD so git
	// moves invalidate the fallback. The display watcher above stays on
	// the jj target, preserving repair detection through the label path.
	#fallbackUnwatch: (() => void) | null = null;
	#fallbackWatchedTarget: string | null = null;

	// Last display-backend sync, bounding re-discovery walks past the
	// initial setup.
	#lastDisplayCheckAt = 0;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#extensionStatuses: Map<string, string> = new Map();

	constructor(private readonly session: AgentSession) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	/**
	 * Set extension status text to display in the footer.
	 * ANSI/VT escape sequences and most control characters are stripped; tabs and newlines become spaces.
	 * The combined status line is trimmed and truncated to terminal width.
	 * @param key - Unique key to identify this status
	 * @param text - Status text, or undefined to clear
	 */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#extensionStatuses.delete(key);
		} else {
			this.#extensionStatuses.set(key, text);
		}
	}

	/**
	 * Watch the repository head for label changes and repaint the footer.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		this.#gitUnwatch?.();
		this.#gitUnwatch = null;

		if (!settings.get("git.enabled")) return;
		const repository = vcs.repoForDisplay(getProjectDir());
		if (!repository) return;

		try {
			const target = repository.watchTarget();
			const unwatch = vcs.watch(repository, () => {
				this.#invalidateBranch();
				this.#onBranchChange?.();
			});
			this.#gitUnwatch = unwatch;
			this.#watchedTarget = target;
		} catch {
			// Silently fail if we can't watch
		}
	}

	// Revalidate the display backend on a bounded cadence rather than every
	// frame: a re-discovery walk runs at most once per TTL, and cached
	// renders do no VCS discovery. Late colocation rebinds the watcher here;
	// the TTL-less branch cache is cleared on change so jj-only label
	// updates flow from then on.
	#syncDisplayWatcher(): void {
		const now = Date.now();
		if (now - this.#lastDisplayCheckAt < FOOTER_DISPLAY_SYNC_TTL_MS) return;
		this.#lastDisplayCheckAt = now;
		let repository: VcsRepo | null;
		try {
			repository = vcs.repoForDisplay(getProjectDir());
		} catch {
			return;
		}
		if (!repository) {
			// No repository: drop stale branch/watcher state rather than
			// retaining the previous backend's label and coverage.
			if (this.#cachedBranch !== undefined || this.#gitUnwatch || this.#branchResolve) {
				this.#gitUnwatch?.();
				this.#gitUnwatch = null;
				this.#watchedTarget = null;
				this.#invalidateBranch();
			}
			return;
		}
		let target: string | null;
		try {
			target = repository.watchTarget();
		} catch {
			return;
		}
		if (target === this.#watchedTarget && this.#gitUnwatch) return;
		// Install before disposing: a failed replacement keeps existing
		// coverage instead of leaving none.
		try {
			const unwatch = vcs.watch(repository, () => {
				this.#invalidateBranch();
				this.#onBranchChange?.();
			});
			this.#gitUnwatch?.();
			this.#gitUnwatch = unwatch;
			this.#watchedTarget = target;
			this.#releaseFallbackWatch();
		} catch {
			// Silently fail if we can't watch; the next TTL window retries.
		}
		this.#invalidateBranch();
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		this.#disposed = true;
		this.#branchResolve?.abort();
		this.#branchResolve = undefined;
		this.#gitUnwatch?.();
		this.#gitUnwatch = null;
		this.#releaseFallbackWatch();
	}

	invalidate(): void {
		this.#invalidateBranch();
	}

	#invalidateBranch(): void {
		this.#branchGeneration++;
		this.#branchResolve?.abort();
		this.#branchResolve = undefined;
		this.#cachedBranch = undefined;
	}
	/**
	 * Operational git fallback for a display whose jj label failed to load:
	 * branch plus the repo to watch for HEAD moves. Only resolves in the
	 * colocated layout (same root): pure-jj and nested layouts have no
	 * usable fallback and keep today's null. Never throws.
	 */
	#gitFallback(display: VcsRepo): { branch: string | null; repo: VcsRepo | null } {
		try {
			const operational = vcs.repo(getProjectDir());
			if (operational?.kind() !== "git" || operational.root() !== display.root()) {
				return { branch: null, repo: null };
			}
			const headState = operational.asGit()?.headSync();
			if (!headState) return { branch: null, repo: operational };
			const branch = headState.kind === "ref" ? (headState.branch ?? headState.refName ?? "HEAD") : "detached";
			return { branch, repo: operational };
		} catch {
			return { branch: null, repo: null };
		}
	}

	/**
	 * Follow the fallback repo's HEAD so a later `git switch` invalidates
	 * the cached fallback branch. Target-keyed: reuses the live watcher
	 * when the repo is unchanged, releases nothing on install failure.
	 */
	#watchFallback(repo: VcsRepo | null): void {
		if (!repo) return;
		let target: string | null = null;
		try {
			target = repo.watchTarget();
		} catch {
			target = null;
		}
		if (target === null || target === this.#fallbackWatchedTarget) return;
		this.#releaseFallbackWatch();
		try {
			const unwatch = vcs.watch(repo, () => {
				this.#invalidateBranch();
				this.#onBranchChange?.();
			});
			this.#fallbackUnwatch = unwatch;
			this.#fallbackWatchedTarget = target;
		} catch {
			// Silently fail if we can't watch; the cached fallback stays
			// until the next invalidation from elsewhere.
		}
	}

	#releaseFallbackWatch(): void {
		this.#fallbackUnwatch?.();
		this.#fallbackUnwatch = null;
		this.#fallbackWatchedTarget = null;
	}

	/**
	 * Get the current branch, bookmark, or change-id label.
	 */
	#getCurrentBranch(): string | null {
		if (!settings.get("git.enabled")) return null;
		this.#syncDisplayWatcher();
		if (this.#cachedBranch !== undefined) {
			return this.#cachedBranch;
		}
		const repository = (() => {
			try {
				return vcs.repoForDisplay(getProjectDir());
			} catch {
				return null;
			}
		})();
		if (!repository) {
			this.#cachedBranch = null;
			return null;
		}
		const gitRepository = repository.asGit();
		if (!gitRepository) {
			if (!this.#branchResolve) {
				const request = new AbortController();
				const generation = this.#branchGeneration;
				this.#branchResolve = request;
				void repository
					.label(request.signal)
					.then(label => {
						if (this.#disposed || this.#branchGeneration !== generation) return;
						this.#releaseFallbackWatch();
						const clean = typeof label === "string" ? sanitizeStatusText(label) : label;
						const changed = this.#cachedBranch !== clean;
						this.#cachedBranch = clean;
						if (changed) this.#onBranchChange?.();
					})
					.catch(() => {
						if (this.#disposed || this.#branchGeneration !== generation) return;
						const fallback = this.#gitFallback(repository);
						const changed = this.#cachedBranch !== fallback.branch;
						this.#cachedBranch = fallback.branch;
						this.#watchFallback(fallback.repo);
						if (changed) this.#onBranchChange?.();
					})
					.finally(() => {
						if (this.#branchResolve === request) this.#branchResolve = undefined;
					});
			}
			return this.#cachedBranch ?? null;
		}

		const headState = (() => {
			try {
				return gitRepository.headSync();
			} catch {
				return null;
			}
		})();
		this.#cachedBranch =
			headState === null
				? null
				: headState.kind === "ref"
					? (headState.branch ?? headState.refName ?? "HEAD")
					: "detached";
		return this.#cachedBranch;
	}

	render(width: number): readonly string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
				totalPremiumRequests += entry.message.usage.premiumRequests ?? 0;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextTokens = contextUsage?.tokens ?? 0;
		const contextPercentValue = contextWindow > 0 ? (contextUsage?.percent ?? 0) : null;

		// Replace home directory with ~
		let pwd = shortenPath(getProjectDir());

		// Add git branch if available
		const branch = this.#getCurrentBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Truncate path if too long to fit width
		if (pwd.length > width) {
			const half = Math.floor(width / 2) - 1;
			if (half > 1) {
				const start = pwd.slice(0, half);
				const end = pwd.slice(-(half - 1));
				pwd = `${start}…${end}`;
			} else {
				pwd = pwd.slice(0, Math.max(1, width));
			}
		}

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatNumber(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatNumber(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatNumber(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatNumber(totalCacheWrite)}`);

		// Show billing summary with subscription and premium-request indicators
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const { auto: autoIcon, subscription: subscriptionIcon } = theme.icon;
		const normalizedPremiumRequests = Math.round((totalPremiumRequests + Number.EPSILON) * 100) / 100;
		if (totalCost || usingSubscription || normalizedPremiumRequests) {
			const billingParts: string[] = [];
			if (totalCost) {
				const formatted = totalCost.toFixed(3);
				if (usingSubscription) {
					const spend =
						theme.getSymbolPreset() === "nerd" && subscriptionIcon
							? `${subscriptionIcon} ${formatted}`
							: `S${formatted}`;
					billingParts.push(spend);
				} else {
					billingParts.push(`$${formatted}`);
				}
			} else if (usingSubscription) {
				billingParts.push(theme.getSymbolPreset() === "nerd" && subscriptionIcon ? subscriptionIcon : "(sub)");
			}
			if (normalizedPremiumRequests) billingParts.push(`★ ${formatNumber(normalizedPremiumRequests)}`);
			if (billingParts.length > 0) statsParts.push(billingParts.join(" "));
		}
		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.#autoCompactEnabled && autoIcon ? ` ${autoIcon}` : "";
		const contextPercentDisplay = `${formatContextUsage(contextPercentValue, contextWindow, contextTokens)}${autoIndicator}`;
		if (contextUsage && contextPercentValue !== null) {
			const color = getContextUsageThemeColor(getContextUsageLevel(contextPercentValue, contextWindow));
			contextPercentStr =
				color === "statusLineContext" ? contextPercentDisplay : theme.fg(color, contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		// Add thinking level hint when the current model advertises supported efforts
		let rightSide = modelName;
		if (state.model?.thinking) {
			if (this.session.isAutoThinking) {
				// Pending (no turn classified yet / classifying) shows a symbol-theme
				// question-box marker; once resolved it shows `<level>`.
				const resolved = this.session.autoResolvedThinkingLevel();
				rightSide = `${modelName} • ${resolved ? resolved : `${theme.thinking.autoPending} auto`}`;
			} else {
				const thinkingLevel = state.thinkingLevel ?? ThinkingLevel.Off;
				rightSide = `${modelName} • ${thinkingLevel}`;
			}
		}

		let statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			// Drop styling and truncate by terminal cells (not code points) so wide
			// glyphs and non-SGR escapes can't overflow the line.
			statsLeft = truncateToWidth(stripVTControlCharacters(statsLeft), width);
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const pad = padding(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + pad + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 3) {
				// Drop styling and truncate by terminal cells so the right side fits.
				const truncatedRight = truncateToWidth(stripVTControlCharacters(rightSide), availableForRight);
				const pad = padding(width - statsLeftWidth - visibleWidth(truncatedRight));
				statsLine = statsLeft + pad + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const lines = [theme.fg("dim", pwd), dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		if (this.#extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(this.#extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width));
		}

		return lines;
	}
}
