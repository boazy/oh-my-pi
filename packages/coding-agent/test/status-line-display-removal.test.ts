/**
 * When re-discovery authoritatively returns null (the repository was
 * removed — e.g. a worktree `.git` pointer retargeted at a missing
 * directory), the stale display handle must be dropped rather than
 * served forever. Discovery *exceptions* (transient I/O) still keep the
 * stale handle; only a successful null means removal. A reappearing
 * repository is picked back up on cadence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const root = "/repo/display-removal";
const targetA = `${root}/.git/HEAD`;

function headFor(branch: string): VcsHeadState {
	return { kind: "ref", branch, refName: `refs/heads/${branch}`, commit: undefined };
}

const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: `${root}/.git`,
	gitDir: `${root}/.git`,
	gitEntryPath: `${root}/.git`,
	headPath: targetA,
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
			getSessionName: () => "display-removal test",
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

function gitRepo(): VcsRepo {
	const handle = {
		defaultBranch: async () => "main",
		headSync: () => headFor("feature/a"),
		linkedWorktree: () => null,
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsGitRepo;
	return {
		kind: () => "git",
		asGit: () => handle,
		asJj: () => null,
		root: () => root,
		watchTarget: () => targetA,
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsRepo;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("StatusLineComponent display removal", () => {
	it("drops the stale handle when rediscovery returns null, and recovers on return", async () => {
		const repo = gitRepo();
		let displayRepo: VcsRepo | null = repo;
		let opRepo: VcsRepo | null = repo;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
		vi.spyOn(vcs, "git").mockReturnValue(repo.asGit());
		vi.spyOn(vcs, "repo").mockImplementation(() => opRepo);
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => displayRepo);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSettings);
		try {
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/a");

			// The repository is removed: both detectors authoritatively
			// return null. The old branch must stop rendering.
			displayRepo = null;
			opRepo = null;
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).not.toContain("feature/a");

			// A reappearing repository is picked back up on cadence.
			displayRepo = repo;
			opRepo = repo;
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/a");
		} finally {
			component.dispose();
		}
	});

	it("keeps the handle when only display blips but operational resolves", async () => {
		const repo = gitRepo();
		let displayRepo: VcsRepo | null = repo;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
		vi.spyOn(vcs, "git").mockReturnValue(repo.asGit());
		vi.spyOn(vcs, "repo").mockReturnValue(repo);
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => displayRepo);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSettings);
		try {
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/a");

			// A lone display null while operational resolves (racing
			// mutation, skewed detectors) must not nuke the handle.
			displayRepo = null;
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/a");
		} finally {
			component.dispose();
		}
	});
	it("keeps the stale handle when discovery throws", async () => {
		const repo = gitRepo();
		let failDiscovery = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
		vi.spyOn(vcs, "git").mockReturnValue(repo.asGit());
		vi.spyOn(vcs, "repo").mockReturnValue(repo);
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => {
			if (failDiscovery) throw new Error("transient I/O");
			return repo;
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSettings);
		try {
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/a");

			failDiscovery = true;
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("feature/a");
		} finally {
			component.dispose();
		}
	});
});
