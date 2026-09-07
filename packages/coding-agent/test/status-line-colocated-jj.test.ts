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

	it("falls back when a linked workspace marker is redirected", async () => {
		const primary = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jj-primary-"));
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jj-linked-"));
		const repoDir = path.join(primary, ".jj", "repo");
		const heads = path.join(repoDir, "op_heads", "heads");
		fs.mkdirSync(heads, { recursive: true });
		// Real secondary layout: `.jj/repo` is a file pointing at the shared
		// repo dir, while the watch target lives in that shared repo.
		fs.mkdirSync(path.join(ws, ".jj"), { recursive: true });
		fs.writeFileSync(path.join(ws, ".jj", "repo"), `${path.relative(path.join(ws, ".jj"), repoDir)}\n`);
		try {
			const operational = operationalGit(ws, headFor("main"));
			const linked = {
				kind: () => "jj",
				asGit: () => null,
				asJj: () => ({}) as never,
				root: () => ws,
				watchTarget: () => heads,
				label: async () => "linked-bookmark",
				statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
			} as unknown as VcsRepo;
			const gitAgain = operationalGit(ws, headFor("main"));
			mockRepos(operational, linked, ws);
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let displayCalls = 0;
			vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (++displayCalls === 1 ? linked : gitAgain));

			const component = new StatusLineComponent(makeSession());
			component.updateSettings(gitSegment);
			component.watchBranch(() => {});

			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("linked-bookmark");

			// Redirect the marker while the shared target survives: a bare
			// target check would keep the stale handle forever.
			fs.writeFileSync(path.join(ws, ".jj", "repo"), "/nonexistent/elsewhere\n");
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("main");
			expect(component.getTopBorder(80).content).not.toContain("linked-bookmark");
			component.dispose();
		} finally {
			fs.rmSync(primary, { recursive: true, force: true });
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	it("drops the cached branch when the display target is redirected", async () => {
		const root = "/repo/retarget";
		const targetA = `${root}/.git/HEAD`;
		const targetB = `${root}/.git/refs/heads/other`;
		const gitA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("branch-a")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const gitB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("branch-b")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const operational = operationalGit(root, headFor("branch-a"));
		mockRepos(operational, gitA, root);
		const watchTargets: string[] = [];
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watchTargets.push(repo.watchTarget());
			return () => {};
		}) as unknown as typeof vcs.watch);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let moved = false;
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? gitB : gitA));

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("branch-a");

		// The `.git` pointer moves with the cwd unchanged: the rebind
		// installs the new target and the stale branch must not survive it,
		// since a fresh watcher never reports the current state.
		moved = true;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		const content = component.getTopBorder(80).content;
		expect(content).toContain("branch-b");
		expect(content).not.toContain("branch-a");
		expect(watchTargets).toEqual([targetA, targetB, targetA]);
		component.dispose();
	});

	it("looks up PRs against the new default after a redirect", async () => {
		const root = "/repo/retarget-defaults";
		const targetA = `${root}/.git-a/HEAD`;
		const targetB = `${root}/.git-b/HEAD`;
		const repoA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const repoB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		let moved = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "repo").mockImplementation(() => (moved ? repoB : repoA));
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? repoB : repoA));
		// Same branch name, different defaults: only the default cache
		// decides whether the lookup fires.
		let defaultName = "main";
		vi.spyOn(vcs, "git").mockImplementation(() => ({
			defaultBranch: async () => defaultName,
			linkedWorktree: () => null,
		}) as unknown as VcsGitRepo);
		const run = vi
			.spyOn(github, "run")
			.mockResolvedValue({ exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();
		expect(run).not.toHaveBeenCalled();

		// Same cwd, new repo with a different default: the lookup follows it.
		moved = true;
		defaultName = "trunk";
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		expect(component.getTopBorder(80).content).toContain("#7");
		component.dispose();
	});

	it("drops an in-flight default-branch lookup across a redirect", async () => {
		const root = "/repo/retarget-inflight";
		const targetA = `${root}/.git-a/HEAD`;
		const targetB = `${root}/.git-b/HEAD`;
		const repoA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("feature")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const repoB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		let moved = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		const firstDefault = Promise.withResolvers<string | null>();
		const secondDefault = Promise.withResolvers<string | null>();
		let defaultCalls = 0;
		vi.spyOn(vcs, "git").mockImplementation(
			(() => ({
				defaultBranch: () => (++defaultCalls === 1 ? firstDefault.promise : secondDefault.promise),
				linkedWorktree: () => null,
			}) as unknown as VcsGitRepo),
		);
		vi.spyOn(vcs, "repo").mockImplementation(() => (moved ? repoB : repoA));
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? repoB : repoA));
		const run = vi
			.spyOn(github, "run")
			.mockResolvedValueOnce({ exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" })
			.mockResolvedValue({ exitCode: 0, stdout: '{"number":8,"url":"https://example.test/x/8"}', stderr: "" });
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);

		// Redirect while the first default lookup is still in flight, then
		// let the stale resolve land: it must not repopulate the cache.
		moved = true;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		firstDefault.resolve("main");
		await flush();
		expect(run).toHaveBeenCalledTimes(1);

		// The fresh lookup for the new repo commits instead.
		secondDefault.resolve("trunk");
		await flush();
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
		expect(component.getTopBorder(80).content).toContain("#8");
		component.dispose();
	});

	it("retries operational re-discovery after a rebind failure", async () => {
		const root = "/repo/refresh-retry";
		const targetA = `${root}/.git-a/HEAD`;
		const targetB = `${root}/.git-b/HEAD`;
		const repoA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const repoB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("branch-b")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		let moved = false;
		let failRepo = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const repoSpy = vi.spyOn(vcs, "repo");
		repoSpy.mockImplementation(() => {
			if (failRepo) throw new Error("no repo");
			return moved ? repoB : repoA;
		});
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? repoB : repoA));
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
		expect(component.getTopBorder(80).content).not.toContain("branch-b");
		expect(run).not.toHaveBeenCalled();

		// The target moves but operational re-discovery throws: the display
		// recovers while PR state stays on the stale handle.
		moved = true;
		failRepo = true;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("branch-b");
		expect(run).not.toHaveBeenCalled();
		const callsAfterFailure = repoSpy.mock.calls.length;

		// Same target, no storm: renders inside the window do not retry.
		component.getTopBorder(80);
		expect(repoSpy.mock.calls.length).toBe(callsAfterFailure);

		// Past the window with the failure cleared, the same target retries
		// through the accessor and the lookup follows the new branch.
		failRepo = false;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		expect(component.getTopBorder(80).content).toContain("#7");
		component.dispose();
	});

	it("drops the cached PR when redirecting onto a default branch", async () => {
		const root = "/repo/retarget-pr";
		const targetA = `${root}/.git-a/HEAD`;
		const targetB = `${root}/.git-b/HEAD`;
		const repoA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("feature")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const repoB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		let moved = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		vi.spyOn(vcs, "repo").mockImplementation(() => (moved ? repoB : repoA));
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? repoB : repoA));
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
		expect(component.getTopBorder(80).content).toContain("#7");
		expect(run).toHaveBeenCalledTimes(1);

		// Redirect onto repo B's default branch: no replacement lookup runs,
		// so repo A's PR must vanish rather than linger.
		moved = true;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		const content = component.getTopBorder(80).content;
		expect(content).not.toContain("#7");
		expect(run).toHaveBeenCalledTimes(1);
		component.dispose();
	});

	it("observes a nested git checkout created under a cached jj workspace", async () => {
		const outer = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jj-outer-"));
		const sub = path.join(outer, "sub");
		fs.mkdirSync(sub, { recursive: true });
		const heads = path.join(outer, ".jj", "repo", "op_heads", "heads");
		fs.mkdirSync(heads, { recursive: true });
		const previousDir = getProjectDir();
		setProjectDir(sub);
		try {
			const jjBase = displayJj(outer, async () => "outer-bookmark", { staged: 0, unstaged: 0, untracked: 0 });
			// displayJj hardcodes a fake watch target; point it at the real one.
			const jjLive = { ...jjBase, watchTarget: () => heads } as unknown as VcsRepo;
			const operationalJj = {
				kind: () => "jj",
				asGit: () => null,
				asJj: () => null,
				root: () => outer,
				watchTarget: () => heads,
				statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
			} as unknown as VcsRepo;
			const nestedGit = operationalGit(sub, headFor("nested-branch"));
			mockRepos(operationalJj, jjLive, sub);
			const watchTargets: string[] = [];
			vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
				watchTargets.push(repo.watchTarget());
				return () => {};
			}) as unknown as typeof vcs.watch);
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let nested = false;
			vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (nested ? nestedGit : jjLive));
			// The probe reuses central discovery per level: only the new
			// nested checkout validates.
			const gitAtSub = { info: () => ({ repoRoot: sub }) } as unknown as VcsGitRepo;
			vi.spyOn(vcs, "git").mockImplementation(((dir: string) => (dir === sub && nested ? gitAtSub : null)) as unknown as typeof vcs.git);

			const component = new StatusLineComponent(makeSession());
			component.updateSettings(gitSegment);
			component.watchBranch(() => {});
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("outer-bookmark");

			// A nested git checkout appears below the cached jj root: past
			// the cadence it takes precedence for dirs inside it.
			fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
			nested = true;
			now += 6_000;
			component.getTopBorder(80);
			await flush();
			expect(component.getTopBorder(80).content).toContain("nested-branch");
			expect(watchTargets).toContain(`${sub}/.git/HEAD`);
			component.dispose();
		} finally {
			setProjectDir(previousDir);
			fs.rmSync(outer, { recursive: true, force: true });
		}
	});

	it("drops a stale lookup when delayed discovery swaps the repo", async () => {
		const root = "/repo/retarget-swapbump";
		const targetA = `${root}/.git-a/HEAD`;
		const targetB = `${root}/.git-b/HEAD`;
		const repoA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("feature")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		const repoB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("branch-b")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
		} as unknown as VcsRepo;
		let moved = false;
		let failRepo = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		const staleOne = Promise.withResolvers<string | null>();
		const staleTwo = Promise.withResolvers<string | null>();
		const freshThree = Promise.withResolvers<string | null>();
		let defaultCalls = 0;
		vi.spyOn(vcs, "git").mockImplementation(
			(() => ({
				defaultBranch: () => {
					defaultCalls++;
					return defaultCalls === 1 ? staleOne.promise : defaultCalls === 2 ? staleTwo.promise : freshThree.promise;
				},
				linkedWorktree: () => null,
			}) as unknown as VcsGitRepo),
		);
		vi.spyOn(vcs, "repo").mockImplementation(() => {
			if (failRepo) throw new Error("no repo");
			return moved ? repoB : repoA;
		});
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? repoB : repoA));
		const run = vi
			.spyOn(github, "run")
			.mockResolvedValueOnce({ exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" })
			.mockResolvedValue({ exitCode: 0, stdout: '{"number":8,"url":"https://example.test/x/8"}', stderr: "" });
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);

		// Move with a failing refresh (stale handle kept, retry flagged),
		// then recover through the accessor: the swap bumps past the
		// second lookup, which must never commit even though it resolves.
		moved = true;
		failRepo = true;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		failRepo = false;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		staleOne.resolve("main");
		staleTwo.resolve("branch-b");
		await flush();
		component.getTopBorder(80);
		await flush();
		expect(run).toHaveBeenCalledTimes(3);
		expect(component.getTopBorder(80).content).toContain("#8");
		component.dispose();
	});

	it("drops a pending status fetch when the target moves", async () => {
		const root = "/repo/status-redirect";
		const targetA = `${root}/.git-a/HEAD`;
		const targetB = `${root}/.git-b/HEAD`;
		const oldStatus = Promise.withResolvers<GitStatus | null>();
		const dispA = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetA,
			statusSummary: () => oldStatus.promise,
		} as unknown as VcsRepo;
		const dispB = {
			kind: () => "git",
			asGit: () => gitHandle(headFor("main")),
			asJj: () => null,
			root: () => root,
			watchTarget: () => targetB,
			statusSummary: async (): Promise<GitStatus | null> => ({ staged: 1, unstaged: 2, untracked: 3 }),
		} as unknown as VcsRepo;
		let moved = false;
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "git").mockReturnValue(null);
		vi.spyOn(vcs, "repo").mockReturnValue(dispA);
		vi.spyOn(vcs, "repoForDisplay").mockImplementation(() => (moved ? dispB : dispA));
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});
		component.getTopBorder(80);
		await flush();

		// Move past the cadence with A's fetch still pending: B launches
		// immediately instead of waiting on it.
		moved = true;
		now += 6_000;
		component.getTopBorder(80);
		await flush();
		let content = component.getTopBorder(80).content;
		expect(content).toContain("*2");
		expect(content).not.toContain("*9");

		// The stale completion lands late and must neither publish nor
		// release the new request's slot.
		oldStatus.resolve({ staged: 9, unstaged: 9, untracked: 9 });
		await flush();
		content = component.getTopBorder(80).content;
		expect(content).toContain("*2");
		expect(content).not.toContain("*9");
		component.dispose();
	});
});
