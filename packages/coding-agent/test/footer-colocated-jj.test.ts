/**
 * #11071 follow-up: when a plain git checkout gains colocation mid-session,
 * the legacy footer must rebind its watcher from `.git/HEAD` to the jj
 * operation-head target — otherwise jj-only label changes never clear the
 * cached git branch, which has no polling TTL.
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
			getSessionName: () => "footer-colocated test",
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

function gitDisplay(root: string, branch: string): VcsRepo {
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

function jjDisplay(root: string, label: () => Promise<string | null>): VcsRepo {
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

describe("FooterComponent display detector", () => {
	it("rebinds the watcher and label when colocation appears after setup", async () => {
		const root = "/repo/footer-colocate";
		const git = gitDisplay(root, "main");
		const jj = jjDisplay(root, async () => `footer-${String.fromCharCode(7)}bookmark`);
		let colocated = false;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (colocated ? jj : git));
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const onBranchChange = vi.fn();
		const component = new FooterComponent(makeSession());
		component.watchBranch(onBranchChange);

		expect(component.render(80).join("\n")).toContain("(main)");

		colocated = true;
		// Past the sync cadence the new backend is observed.
		now += 6_000;
		component.render(80);
		await flush();
		const content = component.render(80).join("\n");
		expect(content).toContain("(footer-");
		expect(content).toContain("bookmark)");
		expect(content).not.toContain(String.fromCharCode(7));
		expect(content).not.toContain("(main)");
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, `${root}/.jj/repo/op_heads/heads`]);
		component.dispose();
	});

	it("retries the install on the unchanged target after a transient failure", async () => {
		const root = "/repo/footer-watch-failure";
		const git = gitDisplay(root, "main");
		const jj = jjDisplay(root, async () => `recovered-${String.fromCharCode(7)}mark`);
		let colocated = false;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (colocated ? jj : git));
		const watchTargets: string[] = [];
		let failJjWatch = true;
		const watchMock = vi.spyOn(vcs, "watch");
		watchMock.mockImplementation(((repo: VcsRepo) => {
			if (repo.kind() === "jj" && failJjWatch) throw new Error("no watch");
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		expect(component.render(80).join("\n")).toContain("(main)");

		// The replacement throws: the label still recovers through the
		// re-read, and the old watcher is retained.
		colocated = true;
		// Past the sync cadence the new backend is observed.
		now += 6_000;
		component.render(80);
		await flush();
		let content = component.render(80).join("\n");
		expect(content).toContain("(recovered-");
		expect(content).not.toContain(String.fromCharCode(7));
		expect(watchTargets).toEqual([`${root}/.git/HEAD`]);
		expect(watchMock).toHaveBeenCalledTimes(2);

		// No per-render retry storm while the target is unchanged.
		component.render(80);
		expect(watchMock).toHaveBeenCalledTimes(2);
		expect(watchTargets).toEqual([`${root}/.git/HEAD`]);

		// The transient failure clears while staying colocated: past the TTL
		// the same target is retried, the jj watcher installs, and refresh works.
		failJjWatch = false;
		now += 6_000;
		component.render(80);
		await flush();
		content = component.render(80).join("\n");
		expect(content).toContain("(recovered-");
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, `${root}/.jj/repo/op_heads/heads`]);
		component.dispose();
	});

	it("clears the branch and watcher when discovery finds no repository", async () => {
		const root = "/repo/footer-vanish";
		const jjHeads = `${root}/.jj/repo/op_heads/heads`;
		const jj = jjDisplay(root, async () => "gone-bookmark");
		const git = gitDisplay(root, "main");
		let mode: "git" | "jj" | "none" = "git";
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (mode === "git" ? git : mode === "jj" ? jj : null));
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		expect(component.render(80).join("\n")).toContain("(main)");

		// Become colocated, then vanish entirely: the bookmark must go
		// away rather than linger with dead coverage.
		mode = "jj";
		now += 6_000;
		component.render(80);
		await flush();
		expect(component.render(80).join("\n")).toContain("(gone-bookmark)");
		mode = "none";
		now += 6_000;
		component.render(80);
		await flush();
		let content = component.render(80).join("\n");
		expect(content).not.toContain("(gone-bookmark)");
		expect(content).not.toContain("(main)");
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, jjHeads]);

		// Reappearing re-installs from a clean slate.
		mode = "jj";
		now += 6_000;
		component.render(80);
		await flush();
		content = component.render(80).join("\n");
		expect(content).toContain("(gone-bookmark)");
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, jjHeads, jjHeads]);
		component.dispose();
	});
});
