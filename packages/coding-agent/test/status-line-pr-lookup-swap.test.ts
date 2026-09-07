/**
 * Regression: a same-cwd repository swap while `github.run()` was pending
 * retired the cached PR but left `#prLookupInFlight` set, so the new
 * repository's `#lookupPr` early-returned null and its PR stayed hidden
 * until the superseded run settled (up to GH_COMMAND_TIMEOUT_MS — five
 * minutes).
 *
 * Contract: `#handleRepositoryTargetChanged` bumps `#prLookupGeneration`
 * and retires the slot, so the new repository starts its own lookup on
 * the next paint; the stale completion is dropped by the generation check
 * (on top of the existing cwd/context guards) and must not clear the new
 * lookup's slot in its finally-block.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const root = "/fake";
const targetA = `${root}/.git-a/HEAD`;
const targetB = `${root}/.git-b/HEAD`;

function headFor(branch: string): VcsHeadState {
	return { kind: "ref", branch, refName: `refs/heads/${branch}`, commit: undefined };
}

const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: `${root}/.git`,
	gitDir: `${root}/.git`,
	gitEntryPath: `${root}/.git`,
	headPath: `${root}/.git/HEAD`,
	repoRoot: root,
	isReftable: false,
};

function gitHandleFor(branch: string): VcsGitRepo {
	return {
		// Sync seed "main" keeps `#isDefaultBranch` false for feature branches.
		defaultBranch: async () => "main",
		headSync: () => headFor(branch),
		linkedWorktree: () => null,
	} as unknown as VcsGitRepo;
}

function repoFor(branch: string, target: string): VcsRepo {
	return {
		kind: () => "git",
		asGit: () => gitHandleFor(branch),
		asJj: () => null,
		root: () => root,
		watchTarget: () => target,
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsRepo;
}

const gitPrSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pr"],
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
			getSessionName: () => "pr-lookup-swap test",
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

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

beforeEach(() => {
	vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("StatusLineComponent PR lookup across repository swaps", () => {
	it("starts a new lookup after a same-cwd swap and drops the stale result", async () => {
		const repoA = repoFor("feature/x", targetA);
		const repoB = repoFor("feature/y", targetB);
		let moved = false;
		vi.spyOn(vcs, "git").mockImplementation(() => gitHandleFor(moved ? "feature/y" : "feature/x"));
		vi.spyOn(vcs, "repo").mockImplementation(() => (moved ? repoB : repoA));
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? repoB : repoA));

		const staleGate = Promise.withResolvers<void>();
		const run = vi.spyOn(github, "run").mockImplementation(async () => {
			if (run.mock.calls.length === 1) {
				// The superseded lookup stays pending across the swap.
				await staleGate.promise;
				return { exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" };
			}
			return { exitCode: 0, stdout: '{"number":8,"url":"https://example.test/x/8"}', stderr: "" };
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSettings);
		try {
			component.getTopBorder(80);
			await flush();
			expect(run).toHaveBeenCalledTimes(1);

			// Same cwd, new repository target: the next paint must start
			// the new repository's lookup instead of waiting out the old one.
			moved = true;
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(run).toHaveBeenCalledTimes(2);

			// The superseded completion must not publish under the new repo.
			staleGate.resolve();
			await flush();
			const content = component.getTopBorder(80).content;
			expect(content).toContain("#8");
			expect(content).not.toContain("#7");
		} finally {
			staleGate.resolve();
			component.dispose();
		}
	});
});
