/**
 * When a colocated jj workspace's store is corrupt, `detect_for_display`
 * still prefers the jj handle (previously the operational detector chose
 * equal-root Git, so the git branch always rendered). The jj label load
 * then rejects on every refresh while the usable git branch stays hidden.
 *
 * Contract: a genuine jj label rejection (not an abort/timeout, not a
 * healthy null) retires that display handle to the already-discovered
 * operational git repo and repaints, so the git branch renders. The
 * retirement is keyed by watch target and re-probes jj at the refresh
 * cadence, so a repaired workspace recovers without a restart.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const root = "/repo/jj-label-fallback";
const jjTarget = `${root}/.jj/repo/op_heads/heads`;
const gitTarget = `${root}/.git/HEAD`;

function headFor(branch: string): VcsHeadState {
	return { kind: "ref", branch, refName: `refs/heads/${branch}`, commit: undefined };
}

const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: `${root}/.git`,
	gitDir: `${root}/.git`,
	gitEntryPath: `${root}/.git`,
	headPath: gitTarget,
	repoRoot: root,
	isReftable: false,
};

const gitSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "jj-label-fallback test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				orchestrationCacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function mockBackends(label: () => Promise<string | null>) {
	const gitHandle = {
		defaultBranch: async () => "main",
		headSync: () => headFor("feature/g"),
		linkedWorktree: () => null,
		statusSummary: async () => ({ staged: 1, unstaged: 2, untracked: 3 }),
	} as unknown as VcsGitRepo;
	const git = {
		kind: () => "git",
		asGit: () => gitHandle,
		asJj: () => null,
		root: () => root,
		watchTarget: () => gitTarget,
		statusSummary: async () => ({ staged: 1, unstaged: 2, untracked: 3 }),
	} as unknown as VcsRepo;
	const jj = {
		kind: () => "jj",
		asGit: () => null,
		asJj: () => null,
		root: () => root,
		watchTarget: () => jjTarget,
		label,
		statusSummary: async (): Promise<{ staged: number; unstaged: number; untracked: number } | null> => {
			throw new Error("store gone");
		},
	} as unknown as VcsRepo;
	vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
	vi.spyOn(vcs, "git").mockReturnValue(gitHandle);
	vi.spyOn(vcs, "repo").mockReturnValue(git);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(jj);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

beforeEach(() => {});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("StatusLineComponent jj label fallback", () => {
	it("serves the colocated git branch while the jj label load rejects", async () => {
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		mockBackends(label);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSettings);
		try {
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/g");
			expect(label).toHaveBeenCalledTimes(1);

			// No hot loop: within the refresh window no new load is issued.
			now += 1_000;
			component.getTopBorder(80);
			await flush();
			expect(label).toHaveBeenCalledTimes(1);
			expect(component.getTopBorder(80).content).toContain("feature/g");

			// Past the window exactly one bounded re-probe runs, still
			// serving git while jj stays broken (no null flash).
			now += 5_000;
			component.getTopBorder(80);
			await flush();
			expect(label).toHaveBeenCalledTimes(2);
			expect(component.getTopBorder(80).content).toContain("feature/g");

			// A repaired workspace recovers without a restart.
			label.mockResolvedValue("fixed-bookmark");
			now += 5_000;
			component.getTopBorder(80);
			await flush();
			const content = component.getTopBorder(80).content;
			expect(content).toContain("fixed-bookmark");
			expect(content).not.toContain("feature/g");
		} finally {
			component.dispose();
		}
	});

	it("does not retire the handle on native cancellation", async () => {
		// The binding's actual timeout shape: repo_blocking rejects with
		// { name: "VcsError", code: "Canceled" } when the signal fires
		// before the native task begins — not a DOM TimeoutError.
		const label = vi
			.fn<() => Promise<string | null>>()
			.mockRejectedValue(Object.assign(new Error("operation canceled"), { name: "VcsError", code: "Canceled" }));
		mockBackends(label);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSettings);
		try {
			component.getTopBorder(80);
			await flush();
			// Transient timeout: keep the (empty) jj presentation and retry
			// on cadence rather than failing over to git.
			expect(component.getTopBorder(80).content).not.toContain("feature/g");
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(label.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(component.getTopBorder(80).content).not.toContain("feature/g");
		} finally {
			component.dispose();
		}
	});

	it("repaints when recovery yields a healthy null label", async () => {
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		mockBackends(label);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		const onBranchChange = vi.fn();
		component.updateSettings(gitSettings);
		component.watchBranch(onBranchChange);
		try {
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/g");
			onBranchChange.mockClear();

			// The store is repaired but holds no bookmark: the load succeeds
			// with null, presentation returns to jj-empty, and the frame
			// must repaint even though no cached value changed.
			label.mockResolvedValue(null);
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(onBranchChange).toHaveBeenCalled();
			expect(component.getTopBorder(80).content).not.toContain("feature/g");
		} finally {
			component.dispose();
		}
	});
});
