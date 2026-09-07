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
		const jj = jjDisplay(root, async () => "footer-bookmark");
		let colocated = false;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (colocated ? jj : git));
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);

		const onBranchChange = vi.fn();
		const component = new FooterComponent(makeSession());
		component.watchBranch(onBranchChange);

		expect(component.render(80).join("\n")).toContain("(main)");

		colocated = true;
		component.render(80);
		await flush();
		const content = component.render(80).join("\n");
		expect(content).toContain("(footer-bookmark)");
		expect(content).not.toContain("(main)");
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, `${root}/.jj/repo/op_heads/heads`]);
		component.dispose();
	});
});
