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
}

function makeConfig(worktree: string): Config {
  return {
    repoName: "demo",
    repo: { path: "/main-checkout", baseRef: "origin/master" },
    jira: { project: "RWR", board: "254", label: "agent", statusTodo: "To Do", statusInDev: "In development", statusReview: "Ready for Code Review" },
    worker: { mainTab: "main", agentPane: "agent" },
    limits: { maxActive: 3, watchHours: 7, developBudgetSeconds: 5400, tickIntervalSeconds: 180 },
    guidance: undefined,
    paths: { configDir: "/c", repoDir: "/c/repos/demo", stateRoot: "/s", stateDir: "/s/demo", dbPath: "/s/db", logsDir: join(worktree, "logs") },
  };
}

function build() {
  const worktree = mkdtempSync(join(tmpdir(), "cats-wt-"));
  tmps.push(worktree);
  let now = 1000;
  const store = new Store(openDb(":memory:"), () => now);
  const state: FakeState = { eligible: [], pr: null, sig: { unresolved: 0, failing: 0, sig: "s0" }, paneState: "idle", paneAlive: true };
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
