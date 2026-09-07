/**
 * Footer twin of the status-line jj label fallback: a colocated workspace
 * whose jj store is corrupt rejects `label()` while the operational git
 * checkout at the same root is fully usable. The footer must render the
 * git branch instead of a permanent null. Pure-jj (or nested) layouts have
 * no fallback target and keep today's null behavior without throwing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FooterComponent } from "@oh-my-pi/pi-coding-agent/modes/components/footer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

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
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "footer-label-fallback test",
			getEntries: () => [],
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof FooterComponent>[0];
}

function gitRepo(root: string, branch: string): VcsRepo {
	const handle = {
		headSync: (): VcsHeadState => ({ kind: "ref", branch, refName: `refs/heads/${branch}`, commit: undefined }),
	} as unknown as VcsGitRepo;
	return {
		kind: () => "git",
		asGit: () => handle,
		asJj: () => null,
		root: () => root,
		watchTarget: () => `${root}/.git/HEAD`,
	} as unknown as VcsRepo;
}

function corruptJj(root: string, label: () => Promise<string | null>): VcsRepo {
	return {
		kind: () => "jj",
		asGit: () => null,
		asJj: () => ({}) as never,
		root: () => root,
		watchTarget: () => `${root}/.jj/repo/op_heads/heads`,
		label,
	} as unknown as VcsRepo;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("FooterComponent jj label fallback", () => {
	it("renders the colocated git branch when the jj label load rejects", async () => {
		const root = "/repo/footer-label-fallback";
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(gitRepo(root, "feature/f"));
		vi.spyOn(vcs, "watch").mockImplementation((() => () => {}) as unknown as typeof vcs.watch);

		const component = new FooterComponent(makeSession());
		const onBranchChange = vi.fn();
		component.watchBranch(onBranchChange);
		try {
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(feature/f)");
			expect(label).toHaveBeenCalledTimes(1);
			// The fallback is a real change (undefined -> branch): it must
			// repaint, or an idle footer keeps the old/empty frame.
			expect(onBranchChange).toHaveBeenCalledTimes(1);
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(feature/f)");
			expect(label).toHaveBeenCalledTimes(1);

			// The fallback is cached: no per-render retry storm.
			component.render(80);
			await flush();
			expect(label).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});

	it("keeps null without throwing when no git fallback exists", async () => {
		const root = "/repo/footer-label-no-fallback";
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(null);
		vi.spyOn(vcs, "watch").mockImplementation((() => () => {}) as unknown as typeof vcs.watch);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).not.toContain("feature/f");
		} finally {
			component.dispose();
		}
	});

	it("follows git HEAD moves while jj stays broken", async () => {
		const root = "/repo/footer-fallback-watch";
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		let gitBranch = "feature/f";
		const git = gitRepo(root, "feature/f");
		const gitHandle = git.asGit();
		if (gitHandle) gitHandle.headSync = () => ({ kind: "ref", branch: gitBranch, refName: `refs/heads/${gitBranch}`, commit: undefined });
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(git);
		const watchers: { kind: string; fire: () => void }[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(
			((repo: VcsRepo, fire: () => void) => {
				watchers.push({ kind: repo.kind(), fire });
				return () => {};
			}) as unknown as typeof vcs.watch,
		);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(feature/f)");
			// Both backends watched: git for the fallback, jj so a repair
			// still invalidates through the label path.
			expect(watchers.map(watcher => watcher.kind).sort()).toEqual(["git", "jj"]);

			// A later `git switch` invalidates the cached fallback even
			// though the jj target never changed.
			gitBranch = "feature/g2";
			watchers.find(watcher => watcher.kind === "git")?.fire();
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(feature/g2)");
		} finally {
			component.dispose();
		}
	});
});
