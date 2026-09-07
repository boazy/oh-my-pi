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
		if (gitHandle)
			gitHandle.headSync = () => ({
				kind: "ref",
				branch: gitBranch,
				refName: `refs/heads/${gitBranch}`,
				commit: undefined,
			});
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(git);
		const watchers: { kind: string; fire: () => void }[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo, fire: () => void) => {
			watchers.push({ kind: repo.kind(), fire });
			return () => {};
		}) as unknown as typeof vcs.watch);

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
	it("re-probes jj on a bounded cadence while the fallback holds", async () => {
		const root = "/repo/footer-fallback-reprobe";
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(gitRepo(root, "feature/f"));
		vi.spyOn(vcs, "watch").mockImplementation((() => () => {}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(feature/f)");
			expect(label).toHaveBeenCalledTimes(1);

			// Within the cadence nothing re-issues: no per-render storm.
			now += 1_000;
			component.render(80);
			await flush();
			expect(label).toHaveBeenCalledTimes(1);

			// Past the cadence exactly one re-probe runs. A still-broken
			// store fails silently back into the same fallback.
			now += 5_000;
			component.render(80);
			await flush();
			expect(label).toHaveBeenCalledTimes(2);
			expect(component.render(80).join("\n")).toContain("(feature/f)");

			// A repaired store recovers without a restart.
			label.mockResolvedValue("fixed-j");
			now += 5_000;
			component.render(80);
			await flush();
			const content = component.render(80).join("\n");
			expect(content).toContain("(fixed-j)");
			expect(content).not.toContain("(feature/f)");
		} finally {
			component.dispose();
		}
	});
	it("re-probes and recovers when the fallback watcher install throws", async () => {
		const root = "/repo/footer-fallback-watch-throw";
		const label = vi.fn<() => Promise<string | null>>().mockRejectedValue(new Error("store gone"));
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(gitRepo(root, "feature/f"));
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			// The git fallback target cannot be watched here, but the
			// jj display target can: fallback must not depend on the
			// install succeeding.
			if (repo.kind() === "git") throw new Error("no watch");
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(feature/f)");
			expect(watchTargets).toEqual([`${root}/.jj/repo/op_heads/heads`]);

			// Past the cadence the jj re-probe runs even though no git
			// watcher could be installed.
			now += 6_000;
			component.render(80);
			await flush();
			expect(label).toHaveBeenCalledTimes(2);
			expect(component.render(80).join("\n")).toContain("(feature/f)");

			// A repaired store still recovers.
			label.mockResolvedValue("fixed-j");
			now += 6_000;
			component.render(80);
			await flush();
			expect(component.render(80).join("\n")).toContain("(fixed-j)");
		} finally {
			component.dispose();
		}
	});
	it("keeps null on native cancellation instead of failing over", async () => {
		const root = "/repo/footer-fallback-transient";
		const label = vi
			.fn<() => Promise<string | null>>()
			.mockRejectedValue(Object.assign(new Error("operation canceled"), { name: "VcsError", code: "Canceled" }));
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(corruptJj(root, label));
		vi.spyOn(vcs, "repo").mockReturnValue(gitRepo(root, "feature/f"));
		const watchKinds: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchKinds.push(repo.kind());
			return () => {};
		}) as unknown as typeof vcs.watch);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			// A mere timeout must not fail over to git: sticky null, and
			// no fallback watcher installed.
			expect(component.render(80).join("\n")).not.toContain("(feature/f)");
			expect(watchKinds).toEqual(["jj"]);
		} finally {
			component.dispose();
		}
	});
});
