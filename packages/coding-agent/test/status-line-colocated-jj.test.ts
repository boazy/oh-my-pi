/**
 * #11071: a colocated jj-git checkout resolved to Git in `detect()`, so the
 * status line showed the git HEAD ("detached" in practice) instead of the
 * active jj bookmark/change id.
 *
 * Presentation now follows a second detector, `vcs.repoForDisplay()`, whose
 * only policy difference is preferring jj on equal-root ties; automation
 * keeps `vcs.repo()`. The component (and legacy footer) split accordingly:
 * branch label, status counts, and the head watcher come from the display
 * repository, while PR lookup keeps resolving the operational git branch —
 * a jj bookmark/change id must never become a GitHub head.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

type GitStatus = { staged: number; unstaged: number; untracked: number };

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
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "display-detector test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function headFor(branch: string): VcsHeadState {
	return { kind: "ref", branch, refName: `refs/heads/${branch}`, commit: undefined };
}
const detachedHead: VcsHeadState = { kind: "detached" };

function repoInfoFor(root: string): VcsGitRepoInfo {
	return {
		commonDir: `${root}/.git`,
		gitDir: `${root}/.git`,
		gitEntryPath: `${root}/.git`,
		headPath: `${root}/.git/HEAD`,
		repoRoot: root,
		isReftable: false,
	};
}

function gitHandle(head: VcsHeadState | null): VcsGitRepo {
	return {
		headSync: () => head,
		linkedWorktree: () => null,
		statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsGitRepo;
}

function gitWithDefaultBranch(branch: string): VcsGitRepo {
	return { defaultBranch: async () => branch, linkedWorktree: () => null } as unknown as VcsGitRepo;
}

function operationalGit(
	root: string,
	head: VcsHeadState | null,
	status: GitStatus = { staged: 0, unstaged: 0, untracked: 0 },
): VcsRepo {
	const handle = {
		headSync: () => head,
		linkedWorktree: () => null,
		statusSummary: async (): Promise<GitStatus | null> => status,
	} as unknown as VcsGitRepo;
	return {
		kind: () => "git",
		asGit: () => handle,
		asJj: () => null,
		root: () => root,
		watchTarget: () => `${root}/.git/HEAD`,
		statusSummary: (signal?: AbortSignal) => handle.statusSummary(signal),
	} as unknown as VcsRepo;
}

function displayJj(root: string, label: () => Promise<string | null>, status: GitStatus): VcsRepo {
	return {
		kind: () => "jj",
		asGit: () => null,
		asJj: () => ({}) as never,
		root: () => root,
		watchTarget: () => `${root}/.jj/repo/op_heads/heads`,
		label,
		statusSummary: async () => status,
	} as unknown as VcsRepo;
}

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};
const gitPrSegments: StatusLineSettings = {
	...gitSegment,
	leftSegments: ["git", "pr"],
};

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function mockRepos(operational: VcsRepo, display: VcsRepo, root: string): void {
	vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
	vi.spyOn(vcs, "git").mockReturnValue(null);
	vi.spyOn(vcs, "repo").mockReturnValue(operational);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(display);
}

describe("StatusLineComponent display detector", () => {
	it("shows the jj bookmark with live git status when colocated", async () => {
		const root = "/repo/colocated";
		const operational = operationalGit(root, headFor("main"), { staged: 1, unstaged: 2, untracked: 3 });
		const display = displayJj(root, async () => "my-bookmark", { staged: 7, unstaged: 8, untracked: 9 });
		mockRepos(operational, display, root);
		const watched: VcsRepo[] = [];
		const watchCallbacks = new Map<string, () => void>();
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo, onChange: () => void) => {
			watched.push(repo);
			watchCallbacks.set(repo.watchTarget(), onChange);
			return () => {};
		}) as unknown as typeof vcs.watch);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80);
		await flush();

		expect(vcs.repoForDisplay).toHaveBeenCalled();
		expect(onBranchChange).toHaveBeenCalled();
		// Both head targets are watched: jj op heads for the label/status,
		// .git/HEAD so a direct git switch invalidates the git branch/PR cache.
		expect(watched.map(repo => repo.watchTarget()).sort()).toEqual(
			[`${root}/.git/HEAD`, `${root}/.jj/repo/op_heads/heads`].sort(),
		);
		// The 1/2/3 counts come from the jj double (the git double reports zeros).
		const content = component.getTopBorder(80).content;
		expect(content).toContain("my-bookmark");
		expect(content).toContain("*2");
		expect(content).toContain("+1");
		expect(content).toContain("?3");
		// Counts come from the live operational git status, not the
		// snapshot-bound jj status.
		expect(content).not.toContain("*8");
		expect(content).not.toContain("+7");
		expect(content).not.toContain("?9");
		// Firing the operational watcher requests a repaint even though jj
		// op heads never moved.
		onBranchChange.mockClear();
		watchCallbacks.get(`${root}/.git/HEAD`)?.();
		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("uses jj status for a nested jj workspace inside a cached git repo", async () => {
		const outer = "/outer";
		const inner = "/outer/sub";
		const operational = operationalGit(outer, headFor("main"));
		const display = displayJj(inner, async () => "inner-bookmark", { staged: 7, unstaged: 8, untracked: 9 });
		mockRepos(operational, display, inner);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		// Different roots mean nesting, not colocation: the jj label shows,
		// but counts come from the jj backend rather than the outer git repo.
		const content = component.getTopBorder(80).content;
		expect(content).toContain("inner-bookmark");
		expect(content).toContain("*8");
		expect(content).toContain("+7");
		expect(content).toContain("?9");
		component.dispose();
	});

	it("keeps the git branch for a nested git checkout under an outer jj workspace", async () => {
		const root = "/repo/nested";
		const operational = operationalGit(root, headFor("git-branch-name"));
		mockRepos(operational, operationalGit(root, headFor("git-branch-name")), root);
		const watched: VcsRepo[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watched.push(repo);
			return () => {};
		}) as unknown as typeof vcs.watch);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("git-branch-name");
		// One backend, one target: no redundant operational watcher.
		expect(watched.map(repo => repo.watchTarget())).toEqual([`${root}/.git/HEAD`]);
		component.dispose();
	});

	it("keeps detached for ordinary git with no jj workspace", async () => {
		const root = "/repo/plain";
		const operational = operationalGit(root, detachedHead);
		mockRepos(operational, operationalGit(root, detachedHead), root);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("detached");
		component.dispose();
	});

	it("does not send the jj bookmark to PR lookup when the git branch is default", async () => {
		const root = "/repo/colocated-pr";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => "feature-x", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const run = vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "{}", stderr: "" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();

		expect(component.getTopBorder(80).content).toContain("feature-x");
		expect(run).not.toHaveBeenCalled();
		component.dispose();
	});

	it("still looks up PRs by the operational git branch when it is not default", async () => {
		const root = "/repo/colocated-pr-live";
		const operational = operationalGit(root, headFor("git-branch-name"));
		const display = displayJj(root, async () => "feature-x", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const run = vi
			.spyOn(github, "run")
			.mockResolvedValue({ exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[1]).toEqual(["pr", "view", "--json", "number,url"]);
		expect(component.getTopBorder(80).content).toContain("feature-x");
		expect(component.getTopBorder(80).content).toContain("#7");
		component.dispose();
	});

	it("picks up colocation that appears after the first paint", async () => {
		const root = "/repo/late-colocate";
		const operational = operationalGit(root, headFor("git-branch-name"));
		const jjDisplay = displayJj(root, async () => "late-bookmark", { staged: 0, unstaged: 0, untracked: 0 });
		const gitDisplay = operationalGit(root, headFor("git-branch-name"));
		mockRepos(operational, gitDisplay, root);
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let displayCalls = 0;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (displayCalls++ === 0 ? gitDisplay : jjDisplay));

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("git-branch-name");

		// Past the revalidation cadence the display detector observes the
		// new jj workspace and the label switches to the bookmark.
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		expect(displayCalls).toBeGreaterThan(1);
		expect(component.getTopBorder(80).content).toContain("late-bookmark");
		// The backend swap rebound the watcher from .git/HEAD to jj op heads.
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, `${root}/.jj/repo/op_heads/heads`, `${root}/.git/HEAD`]);
		component.dispose();
	});

	it("rebinds watchers when the head target moves without a backend change", async () => {
		const root = "/repo/target-move";
		const operational = operationalGit(root, headFor("main"));
		const before = operationalGit(root, headFor("main"));
		const after = {
			...operationalGit(root, headFor("main")),
			watchTarget: () => `${root}/.git/refs/heads/main`,
		} as unknown as VcsRepo;
		mockRepos(operational, before, root);
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const movedAt = now + 6_000;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (now >= movedAt ? after : before));

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("main");

		// Same kind, same root, new head target: the watcher follows it.
		now = movedAt;
		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("main");
		// Both watchers rebound: display follows the new target while
		// operational .git/HEAD coverage is retained.
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, `${root}/.git/refs/heads/main`, `${root}/.git/HEAD`]);
		component.dispose();
	});

	it("polls the operational branch when its watcher fails to install", async () => {
		const root = "/repo/watch-failure";
		let current = headFor("branch-a");
		const liveHandle = { ...gitHandle(headFor("branch-a")), headSync: () => current };
		const operational = {
			...operationalGit(root, headFor("branch-a")),
			asGit: () => liveHandle,
		} as unknown as VcsRepo;
		const display = displayJj(root, async () => "feature-x", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		// The display watcher installs; the operational one throws.
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			if (repo.kind() === "git") throw new Error("no watcher");
			return () => {};
		}) as unknown as typeof vcs.watch);
		const run = vi
			.spyOn(github, "run")
			.mockResolvedValue({ exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" });
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);

		// A git switch moves .git/HEAD with no watcher to fire it; past the
		// poll cadence the lookup follows the new branch instead of the cache.
		current = headFor("branch-b");
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
		component.dispose();
	});

	it("sanitizes control characters from the jj label", async () => {
		const root = "/repo/sanitize";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => `evil-${String.fromCharCode(27)}[2J-bookmark`, { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		const content = component.getTopBorder(80).content;
		const ESC = String.fromCharCode(27);
		expect(content).toContain("evil-");
		expect(content).toContain("bookmark");
		// The repository-controlled erase-display payload is gone, while the
		// renderer's own theme ANSI (also ESC-led) still styles the frame.
		expect(content.includes(`${ESC}[2J`)).toBe(false);
		component.dispose();
	});

	it("falls back to re-discovery when the jj workspace vanishes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jj-vanish-"));
		const heads = path.join(dir, ".jj", "repo", "op_heads", "heads");
		fs.mkdirSync(heads, { recursive: true });
		try {
			const operational = operationalGit(dir, headFor("main"));
			const jjGone = displayJj(dir, async () => "gone-bookmark", { staged: 0, unstaged: 0, untracked: 0 });
			const gitAgain = operationalGit(dir, headFor("main"));
			mockRepos(operational, jjGone, dir);
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let displayCalls = 0;
			vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (++displayCalls === 1 ? jjGone : gitAgain));

			const component = new StatusLineComponent(makeSession());
			component.updateSettings(gitSegment);
			component.watchBranch(() => {});

			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("gone-bookmark");

			// The workspace vanishes; past the cadence the display falls
			// back to re-discovery and the git branch returns.
			fs.rmSync(path.join(dir, ".jj"), { recursive: true, force: true });
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("main");
			expect(component.getTopBorder(80).content).not.toContain("gone-bookmark");
			component.dispose();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a live jj workspace without re-discovery walks", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jj-alive-"));
		const heads = path.join(dir, ".jj", "repo", "op_heads", "heads");
		fs.mkdirSync(heads, { recursive: true });
		try {
			const operational = operationalGit(dir, headFor("main"));
			const display = displayJj(dir, async () => "steady-bookmark", { staged: 0, unstaged: 0, untracked: 0 });
			mockRepos(operational, display, dir);
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let displayCalls = 0;
			vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => {
				displayCalls++;
				return display;
			});

			const component = new StatusLineComponent(makeSession());
			component.updateSettings(gitSegment);
			component.watchBranch(() => {});

			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("steady-bookmark");

			// Past the cadence the live watch target short-circuits: no walk.
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(displayCalls).toBe(1);
			expect(component.getTopBorder(80).content).toContain("steady-bookmark");
			component.dispose();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("installs one watcher pair when setup re-enters on a backend change", async () => {
		const root = "/repo/reentrant-setup";
		const operational = operationalGit(root, headFor("main"));
		const gitDisplay = operationalGit(root, headFor("main"));
		const jjDisplay = displayJj(root, async () => "reentrant-bookmark", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, gitDisplay, root);
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const movedAt = now + 6_000;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (now >= movedAt ? jjDisplay : gitDisplay));

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("main");

		// Past the cadence the detector observes colocation; re-running
		// setup re-enters it through revalidation, and the guard leaves a
		// single pair installed instead of leaking a duplicate.
		now = movedAt;
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("reentrant-bookmark");
		expect(watchTargets).toEqual([`${root}/.git/HEAD`, `${root}/.jj/repo/op_heads/heads`, `${root}/.git/HEAD`]);
		component.dispose();
	});
});
