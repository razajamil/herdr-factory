import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { reconcileRepo, reconcileRun } from "../src/core/reconcile.ts";
import type { Deps, GitApi, GitHubApi, HerdrApi, JiraApi } from "../src/core/deps.ts";
import type { Config, Secrets } from "../src/config.ts";
import type { PrInfo, ReviewSig, Ticket } from "../src/types.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

interface FakeState {
  eligible: Ticket[];
  pr: PrInfo | null;
  sig: ReviewSig;
  paneState: string;
  paneAlive: boolean;
  headSha: string;
}

function makeConfig(worktree: string): Config {
  return {
    repoName: "demo",
    repo: { path: "/main-checkout", baseRef: "origin/master" },
    jira: { project: "RWR", board: "254", label: "agent", statusTodo: "To Do", statusInDev: "In development", statusReview: "Ready for Code Review" },
    worker: { mainTab: "main", agentPane: "agent" },
    limits: { maxActive: 3, watchHours: 7, developBudgetSeconds: 5400, workerDoneGraceSeconds: 1800, stallSeconds: 2700, reviewBudgetSeconds: 1800, tickIntervalSeconds: 60 },
    guidance: undefined,
    paths: { configDir: "/c", repoDir: "/c/repos/demo", stateRoot: "/s", stateDir: "/s/demo", dbPath: "/s/db", logsDir: join(worktree, "logs") },
  };
}

function build() {
  const worktree = mkdtempSync(join(tmpdir(), "cats-wt-"));
  tmps.push(worktree);
  let now = 1000;
  const store = new Store(openDb(":memory:"), () => now);
  const state: FakeState = { eligible: [], pr: null, sig: { unresolved: 0, failing: 0, sig: "s0" }, paneState: "idle", paneAlive: true, headSha: "sha0" };
  const calls = {
    transitions: [] as [string, string][],
    agentSend: [] as [string, string][],
    worktreeRemove: [] as string[],
    branchDelete: [] as string[],
    agentStart: 0,
    notify: 0,
  };
  const herdr: HerdrApi = {
    worktreeCreate: async () => ({ workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1" }),
    worktreeOpen: async () => ({ workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1" }),
    worktreeRemove: async (id) => { calls.worktreeRemove.push(id); },
    workspaceExists: async () => false,
    paneState: async () => state.paneState,
    paneAlive: async () => state.paneAlive,
    paneHasClaude: async () => true,
    tabPaneByLabel: async () => "w1:p1",
    agentStart: async () => { calls.agentStart += 1; return "w1:p2"; },
    paneRun: async () => {},
    agentSend: async (p, t) => { calls.agentSend.push([p, t]); },
    paneSendKeys: async () => {},
    agentRename: async () => {},
    notify: async () => { calls.notify += 1; },
  };
  const jira: JiraApi = {
    listEligible: async () => state.eligible,
    getIssue: async (key) => ({ key, fields: { summary: "s", status: { name: "To Do" }, issuetype: { name: "Bug" }, labels: [], attachment: [] } }),
    currentStatus: async () => "To Do",
    transition: async (k, t) => { calls.transitions.push([k, t]); return true; },
    downloadImages: async () => [],
  };
  const github: GitHubApi = {
    prForBranch: async () => state.pr,
    reviewSignature: async () => state.sig,
  };
  const git: GitApi = {
    branchExists: async () => false,
    branchDelete: async (_cwd, b) => { calls.branchDelete.push(b); },
    worktreePrune: async () => {},
    originUrl: async () => "git@github.com:o/n.git",
    headSha: async () => state.headSha,
  };
  const secrets: Secrets = { jiraBaseUrl: "https://x", jiraEmail: "e", jiraApiToken: "t" };
  const deps: Deps = { config: makeConfig(worktree), secrets, store, ghRepo: "o/n", herdr, jira, github, git, log: () => {}, now: () => now, sleep: async () => {} };
  return { deps, store, state, calls, setNow: (n: number) => { now = n; }, worktree };
}

const ticket = (key: string): Ticket => ({ key, summary: "Fix the thing", type: "Bug" });

describe("reconcile", () => {
  it("claims an eligible ticket → developing (worktree + worker + In-dev transition)", async () => {
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("K-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "K-1")!;
    expect(run.phase).toBe("developing");
    expect(run.branch).toBe("fix/K-1-fix-the-thing");
    expect(run.workspaceId).toBe("w1");
    expect(run.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // brief dispatched to the agent pane
    expect(calls.transitions).toContainEqual(["K-1", "In development"]);
  });

  it("respects the concurrency cap", async () => {
    const { deps, store, state } = build();
    deps.config.limits.maxActive = 1;
    state.eligible = [ticket("K-1"), ticket("K-2")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
  });

  it("developing + open PR but worker not done → stays developing", async () => {
    const { deps, store, state } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-3", summary: "s", issueType: "Bug", branch: "fix/K-3-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, paneId: "w1:p1" });
    state.pr = { number: 7, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("developing");
    expect(store.getRun(run.id)!.prNumber).toBe(7);
  });

  it("developing + open PR + worker-done → reviewing (review transition + deadline)", async () => {
    const { deps, store, state, calls } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-4", summary: "s", issueType: "Bug", branch: "fix/K-4-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", paneId: "w1:p1", workerDone: true });
    state.pr = { number: 8, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.watchDeadline).toBe(1000 + 7 * 3600);
    expect(calls.transitions).toContainEqual(["K-4", "Ready for Code Review"]);
  });

  const reviewCfg = { tab: "review", pane: "agent", promptFile: "/c/repos/demo/review-prompt.md", prompt: "Run the mechanical review." };

  it("developing + worker-done + review configured → auto_review (spawns review agent, no Jira move yet)", async () => {
    const { deps, store, state, calls } = build();
    deps.config.review = reviewCfg;
    const run = store.createRun({ repo: "demo", ticketKey: "K-R1", summary: "s", issueType: "Bug", branch: "fix/K-R1-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, paneId: "w1:p1", workerDone: true });
    state.pr = { number: 12, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("auto_review");
    expect(got.reviewPane).toBe("w1:p1"); // dispatched into the configured pane
    expect(got.reviewDone).toBe(false);
    expect(got.watchDeadline).toBe(1000 + 1800); // review budget
    expect(calls.agentSend.length).toBe(1); // review prompt sent
    // the prompt carries the configured body + a footer that releases the gate
    const sent = calls.agentSend[0]![1];
    expect(sent).toContain("Run the mechanical review.");
    expect(sent).toContain("review-done K-R1");
    expect(sent).toContain("--repo demo");
    expect(calls.transitions).not.toContainEqual(["K-R1", "Ready for Code Review"]);
  });

  it("auto_review + review-done → reviewing (review transition + deadline)", async () => {
    const { deps, store, state, calls } = build();
    deps.config.review = reviewCfg;
    const run = store.createRun({ repo: "demo", ticketKey: "K-R2", summary: "s", issueType: "Bug", branch: "fix/K-R2-s" });
    store.updateRun(run.id, { phase: "auto_review", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, reviewPane: "w1:p1", prNumber: 13, watchDeadline: 99999, reviewDone: true });
    state.pr = { number: 13, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.watchDeadline).toBe(1000 + 7 * 3600);
    expect(calls.transitions).toContainEqual(["K-R2", "Ready for Code Review"]);
    expect(calls.agentSend.length).toBe(0); // review-done short-circuits before any re-spawn
  });

  it("auto_review + review budget elapsed (not done) → proceeds to reviewing", async () => {
    const { deps, store, state, calls, setNow } = build();
    deps.config.review = reviewCfg;
    const run = store.createRun({ repo: "demo", ticketKey: "K-R3", summary: "s", issueType: "Bug", branch: "fix/K-R3-s" });
    store.updateRun(run.id, { phase: "auto_review", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, reviewPane: "w1:p1", prNumber: 14, watchDeadline: 1500, reviewDone: false });
    state.pr = { number: 14, state: "OPEN", url: "u" };
    setNow(1600); // past the review deadline
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
    expect(calls.transitions).toContainEqual(["K-R3", "Ready for Code Review"]);
  });

  it("auto_review + review pane dead before signalling → re-spawns review agent", async () => {
    const { deps, store, state, calls } = build();
    deps.config.review = reviewCfg;
    state.paneAlive = false; // review pane gone
    const run = store.createRun({ repo: "demo", ticketKey: "K-R4", summary: "s", issueType: "Bug", branch: "fix/K-R4-s" });
    store.updateRun(run.id, { phase: "auto_review", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, reviewPane: "w1:dead", prNumber: 15, watchDeadline: 99999, reviewDone: false });
    state.pr = { number: 15, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("auto_review"); // still gating
    expect(calls.agentSend.length).toBe(1); // re-dispatched
  });

  it("auto_review + PR merged out-of-band → reviewing (lets reviewing tear down merged)", async () => {
    const { deps, store, state } = build();
    deps.config.review = reviewCfg;
    const run = store.createRun({ repo: "demo", ticketKey: "K-R5", summary: "s", issueType: "Bug", branch: "fix/K-R5-s" });
    store.updateRun(run.id, { phase: "auto_review", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, reviewPane: "w1:p1", prNumber: 16, watchDeadline: 99999, reviewDone: false });
    state.pr = { number: 16, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
  });

  it("auto_review + PR closed/abandoned out-of-band → teardown (no bogus Jira review transition)", async () => {
    const { deps, store, state, calls } = build();
    deps.config.review = reviewCfg;
    const run = store.createRun({ repo: "demo", ticketKey: "K-R6", summary: "s", issueType: "Bug", branch: "fix/K-R6-s" });
    store.updateRun(run.id, { phase: "auto_review", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, reviewPane: "w1:p1", prNumber: 17, watchDeadline: 99999, reviewDone: false });
    state.pr = { number: 17, state: "CLOSED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("closed");
    expect(calls.transitions).not.toContainEqual(["K-R6", "Ready for Code Review"]);
    expect(calls.worktreeRemove).toContain("w1");
  });

  it("developing + no PR past budget → attention", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-5", summary: "s", issueType: "Bug", branch: "fix/K-5-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", paneId: "w1:p1" });
    state.pr = null;
    setNow(1000 + 5401);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("developing + no PR past budget but worker still working → extended (stays developing)", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-5b", summary: "s", issueType: "Bug", branch: "fix/K-5b-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", paneId: "w1:p1" });
    state.pr = null;
    state.paneState = "working"; // legitimately long task, still grinding
    setNow(1000 + 5401);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("developing");
    expect(calls.notify).toBe(0);
  });

  it("developing + PR open + worker idle past grace → attention", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-G1", summary: "s", issueType: "Bug", branch: "fix/K-G1-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", paneId: "w1:p1", prNumber: 20, watchDeadline: 1500 });
    state.pr = { number: 20, state: "OPEN", url: "u" };
    state.paneState = "idle"; // finished/forgot worker-done
    setNow(1600); // past the grace deadline
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("developing + PR open + worker still working past grace → extended (stays developing)", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-G2", summary: "s", issueType: "Bug", branch: "fix/K-G2-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", paneId: "w1:p1", prNumber: 21, watchDeadline: 1500 });
    state.pr = { number: 21, state: "OPEN", url: "u" };
    state.paneState = "working"; // still on its CI/bot round
    setNow(1600);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("developing");
    expect(calls.notify).toBe(0);
  });

  it("developing + PR open + no grace clock yet → starts the clock, stays developing", async () => {
    const { deps, store, state } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-G3", summary: "s", issueType: "Bug", branch: "fix/K-G3-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", paneId: "w1:p1" });
    state.pr = { number: 22, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("developing");
    expect(got.watchDeadline).toBe(1000 + 1800); // grace clock anchored to PR-open
  });

  it("developing + worker 'working' but no commit progress past stall → attention (heartbeat)", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-H1", summary: "s", issueType: "Bug", branch: "fix/K-H1-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, paneId: "w1:p1", progressSig: "sha0", progressAt: 1000 });
    state.pr = null;
    state.headSha = "sha0"; // HEAD frozen → no progress
    state.paneState = "working"; // agent claims to be working...
    setNow(1000 + 2701); // ...but stalled past stall_seconds (2700)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("developing + commits advancing keep the heartbeat alive → not stalled (extended)", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-H2", summary: "s", issueType: "Bug", branch: "fix/K-H2-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, paneId: "w1:p1", progressSig: "sha0", progressAt: 1000 });
    state.pr = null;
    state.headSha = "sha1"; // HEAD moved → progress!
    state.paneState = "working";
    setNow(1000 + 2701);
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("developing");
    expect(got.progressSig).toBe("sha1"); // heartbeat advanced
    expect(got.progressAt).toBe(1000 + 2701); // reset to now
    expect(calls.notify).toBe(0);
  });

  it("developing + PR open + worker 'working' but stalled → attention (heartbeat overrides status)", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-H3", summary: "s", issueType: "Bug", branch: "fix/K-H3-s" });
    store.updateRun(run.id, { phase: "developing", workspaceId: "w1", worktreePath: deps.config.paths.logsDir, paneId: "w1:p1", prNumber: 30, watchDeadline: 99999, progressSig: "sha0", progressAt: 1000 });
    state.pr = { number: 30, state: "OPEN", url: "u" };
    state.headSha = "sha0"; // frozen
    state.paneState = "working";
    setNow(1000 + 2701); // grace NOT expired (99999), but stalled
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("reviewing + merged PR → teardown (worktree remove + branch delete, ended merged)", async () => {
    const { deps, store, state, calls } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-6", summary: "s", issueType: "Bug", branch: "fix/K-6-s" });
    store.updateRun(run.id, { phase: "reviewing", workspaceId: "w1", paneId: "w1:p1", watchDeadline: 99999 });
    state.pr = { number: 9, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(store.countActive("demo")).toBe(0);
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/K-6-s");
  });

  it("reviewing + actionable new signature + worker idle → wakes resolver", async () => {
    const { deps, store, state, calls } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-7", summary: "s", issueType: "Bug", branch: "fix/K-7-s" });
    store.updateRun(run.id, { phase: "reviewing", workspaceId: "w1", paneId: "w1:p1", watchDeadline: 99999, lastThreadSig: "old" });
    state.pr = { number: 10, state: "OPEN", url: "u" };
    state.sig = { unresolved: 2, failing: 0, sig: "newsig" };
    state.paneState = "idle";
    state.paneAlive = true;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.length).toBe(1); // re-prompted the live worker pane
    expect(store.getRun(run.id)!.lastThreadSig).toBe("newsig");
  });

  it("reviewing + worker still working → does not pile on", async () => {
    const { deps, store, state, calls } = build();
    const run = store.createRun({ repo: "demo", ticketKey: "K-8", summary: "s", issueType: "Bug", branch: "fix/K-8-s" });
    store.updateRun(run.id, { phase: "reviewing", workspaceId: "w1", paneId: "w1:p1", watchDeadline: 99999, lastThreadSig: "old" });
    state.pr = { number: 11, state: "OPEN", url: "u" };
    state.sig = { unresolved: 1, failing: 0, sig: "newsig" };
    state.paneState = "working";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.length).toBe(0);
  });
});
