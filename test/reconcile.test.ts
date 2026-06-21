import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { applyPendingFocus, reconcileRepo, reconcileRun, withTickLock } from "../src/core/reconcile.ts";
import type { Deps, GitApi, GitHubApi, HerdrApi, JiraApi } from "../src/core/deps.ts";
import type { Config, Secrets } from "../src/config.ts";
import type { FocusedPane, Phase, PrInfo, ReviewSig, StepName, Ticket } from "../src/types.ts";

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
  deadPanes: Set<string>; // panes herdr no longer tracks (paneAlive → false)
  headSha: string;
  sessionId: string | null;
  workspaceExists: boolean; // does the workspace still exist after a worktree remove?
  focusedPane: FocusedPane | null; // the pane the user is currently looking at
}

function makeConfig(worktree: string): Config {
  const agent = (tab: string) => ({ tab, pane: "agent", promptType: "replace" as const, promptFile: `/c/repos/demo/${tab}.md`, prompt: `${tab.toUpperCase()} prompt` });
  return {
    repoName: "demo",
    repo: { path: "/main-checkout", baseRef: "origin/master" },
    jira: { baseUrl: "https://x", project: "RWR", board: "254", label: "agent", statusTodo: "To Do", statusInDev: "In development", statusReview: "Ready for Code Review" },
    agents: { fix: agent("fix"), review: agent("review"), pr: agent("pr") },
    limits: { maxActive: 3, watchHours: 7, developBudgetSeconds: 5400, stallSeconds: 2700, reviewBudgetSeconds: 1800, prBudgetSeconds: 3600, tickIntervalSeconds: 60, layoutWaitSeconds: 600 },
    guidance: undefined,
    paths: { configDir: "/c", repoDir: "/c/repos/demo", stateRoot: "/s", stateDir: "/s/demo", dbPath: "/s/db", logsDir: join(worktree, "logs") },
  };
}

function build() {
  const worktree = mkdtempSync(join(tmpdir(), "cats-wt-"));
  tmps.push(worktree);
  let now = 1000;
  const store = new Store(openDb(":memory:"), () => now);
  const state: FakeState = { eligible: [], pr: null, sig: { unresolved: 0, failing: 0, sig: "s0" }, paneState: "idle", deadPanes: new Set(), headSha: "sha0", sessionId: "sess-1", workspaceExists: false, focusedPane: { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" } };
  const calls = {
    transitions: [] as [string, string][],
    agentSend: [] as [string, string][],
    agentFocus: [] as string[],
    worktreeRemove: [] as string[],
    workspaceClose: [] as string[],
    rmrf: [] as string[],
    branchDelete: [] as string[],
    agentStart: 0,
    notify: 0,
  };
  const herdr: HerdrApi = {
    worktreeCreate: async () => ({ workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1" }),
    worktreeOpen: async () => ({ workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1" }),
    worktreeRemove: async (id) => { calls.worktreeRemove.push(id); },
    workspaceClose: async (id) => { calls.workspaceClose.push(id); },
    workspaceExists: async () => state.workspaceExists,
    paneState: async () => state.paneState,
    paneAlive: async (id) => !state.deadPanes.has(id),
    agentSessionId: async () => state.sessionId,
    tabPaneByLabel: async () => "w1:p1",
    agentStart: async () => { calls.agentStart += 1; return "w1:p2"; },
    paneRun: async () => {},
    agentSend: async (p, t) => { calls.agentSend.push([p, t]); },
    agentFocus: async (id) => { calls.agentFocus.push(id); },
    focusedPane: async () => state.focusedPane,
    paneSendKeys: async () => {},
    agentRename: async () => {},
    notify: async () => { calls.notify += 1; },
  };
  const jira: JiraApi = {
    listEligible: async () => state.eligible,
    getIssue: async (key) => ({ key, fields: { summary: "s", status: { name: "To Do" }, issuetype: { name: "Bug" }, labels: [], attachment: [] } }),
    currentStatus: async () => "To Do",
    transition: async (k, t) => { calls.transitions.push([k, t]); return true; },
    downloadAttachments: async () => [],
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
  const secrets: Secrets = { jiraEmail: "e", jiraApiToken: "t" };
  const deps: Deps = { config: makeConfig(worktree), secrets, store, ghRepo: "o/n", herdr, jira, github, git, log: () => {}, now: () => now, sleep: async () => {}, rmrf: async (p) => { calls.rmrf.push(p); } };
  return { deps, store, state, calls, setNow: (n: number) => { now = n; }, worktree };
}

const ticket = (key: string): Ticket => ({ key, summary: "Fix the thing", type: "Bug" });

/** Seed an active run already parked at `phase`, with the active step's run_step spawned. */
function seed(store: Store, worktree: string, key: string, phase: Phase, step: StepName | null, extra: Record<string, unknown> = {}) {
  const run = store.createRun({ repo: "demo", ticketKey: key, summary: "s", issueType: "Bug", branch: `fix/${key}-s` });
  store.updateRun(run.id, { phase, workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1", ...extra });
  if (step) store.upsertRunStep(run.id, step, { paneId: "w1:p1" });
  return store.getRun(run.id)!;
}

describe("reconcile pipeline", () => {
  it("claims an eligible ticket → fixing (worktree + fix agent + ticket fetch + In-dev transition)", async () => {
    const { deps, store, state, calls, worktree } = build();
    state.eligible = [ticket("K-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "K-1")!;
    expect(run.phase).toBe("fixing");
    expect(run.branch).toBe("fix/K-1-fix-the-thing");
    expect(run.workspaceId).toBe("w1");
    expect(run.paneId).toBe("w1:p1"); // latest active pane = the fix agent
    expect(store.getRunStep(run.id, "fix")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // fix prompt dispatched
    expect(calls.transitions).toContainEqual(["K-1", "In development"]);
    // materializeTicket wrote the ticket body the fix agent reads
    expect(existsSync(join(worktree, ".memory/herdr-factory/ticket.json"))).toBe(true);
  });

  it("claiming + configured pane not idle yet → waits (stays claiming, never spawns its own)", async () => {
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("W-1")];
    state.paneState = "working"; // the layout pane exists but its agent isn't idle yet
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "W-1")!;
    expect(run.phase).toBe("claiming"); // did NOT advance to fixing
    expect(calls.agentSend.length).toBe(0); // nothing dispatched yet
    expect(calls.agentStart).toBe(0); // and crucially did NOT spawn its own
    expect(store.getRunStep(run.id, "fix")?.paneId).toBeNull();
    expect(calls.transitions).not.toContainEqual(["W-1", "In development"]);
  });

  it("claiming + configured pane never comes up past layout_wait → attention (no own pane)", async () => {
    const { deps, store, state, calls, setNow } = build();
    state.eligible = [ticket("W-2")];
    state.paneState = "working";
    await reconcileRepo(deps); // first pass begins the wait (fix.started_at = 1000)
    expect(store.activeRunForTicket("demo", "W-2")!.phase).toBe("claiming");
    setNow(1000 + 601); // past layout_wait_seconds (600)
    const run = store.activeRunForTicket("demo", "W-2")!;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
    expect(calls.agentStart).toBe(0); // never spawned its own
  });

  it("step with no tab/pane configured → spawns its own dedicated pane", async () => {
    const { deps, store, state, calls } = build();
    deps.config.agents.fix = { ...deps.config.agents.fix, tab: undefined, pane: undefined };
    state.eligible = [ticket("S-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "S-1")!;
    expect(run.phase).toBe("fixing");
    expect(calls.agentStart).toBe(1); // spawned its own (the only path that creates a pane)
    expect(store.getRunStep(run.id, "fix")?.paneId).toBe("w1:p2"); // agentStart's pane
    expect(calls.agentSend.length).toBe(0); // prompt was passed as argv, not sent to a layout pane
    expect(calls.transitions).toContainEqual(["S-1", "In development"]);
  });

  it("withTickLock runs fn when the lock is free, skips it when a tick already holds it", async () => {
    const { deps } = build();
    let ran = 0;
    expect(await withTickLock(deps, async () => { ran += 1; })).toBe(true);
    expect(ran).toBe(1);
    deps.store.acquireLock("tick:demo", "other-pid", 300); // a tick is mid-flight
    expect(await withTickLock(deps, async () => { ran += 1; })).toBe(false);
    expect(ran).toBe(1); // fn not run while the lock is held
  });

  it("respects the concurrency cap", async () => {
    const { deps, store, state } = build();
    deps.config.limits.maxActive = 1;
    state.eligible = [ticket("K-1"), ticket("K-2")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
  });

  it("fixing + fix agent not done → stays fixing (awaits step-done)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-3", "fixing", "fix");
    await reconcileRun(deps, run);
    expect(store.getRun(run.id)!.phase).toBe("fixing");
    expect(calls.agentSend.length).toBe(0); // alive + working, nothing to do
  });

  it("fixing + step-done fix → auto_review (spawns review agent, no Jira move; wires the handoff)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-4", "fixing", "fix");
    store.markStepDone(run.id, "fix");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("auto_review");
    expect(store.getRunStep(run.id, "review")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // review prompt dispatched
    // user is viewing this worktree on a pipeline pane (default focusedPane) → focus follows
    // the active step to the review pane, and the pending flag is cleared
    expect(calls.agentFocus).toContain("w1:p1");
    expect(got.focusPending).toBe(false);
    expect(calls.transitions).not.toContainEqual(["K-4", "Ready for Code Review"]);
    // the rendered review prompt (written to the worktree) carries the work body, the
    // prior handoff pointer, and the engine-injected step-done footer.
    const body = readFileSync(join(worktree, ".memory/herdr-factory/prompt-review.md"), "utf8");
    expect(body).toContain("REVIEW prompt");
    expect(body).toContain("handoff-fix.md");
    expect(body).toContain("step-done K-4 review");
    // the prior step's pane + session id are captured at handoff and wired into the prompt
    // (the on-demand cross-agent query handles)
    expect(store.getRunStep(run.id, "fix")?.sessionId).toBe("sess-1");
    expect(body).toContain("w1:p1"); // prior pane
    expect(body).toContain("sess-1"); // prior session id
  });

  it("auto_review + step-done review → pr_round (spawns pr agent)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-5", "auto_review", "review");
    store.markStepDone(run.id, "review");
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("pr_round");
    expect(store.getRunStep(run.id, "pr")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1);
  });

  it("pr_round + PR open + step-done pr → reviewing (review transition + deadline)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-6", "pr_round", "pr", { prNumber: 13 });
    store.markStepDone(run.id, "pr");
    state.pr = { number: 13, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.watchDeadline).toBe(1000 + 7 * 3600);
    expect(calls.transitions).toContainEqual(["K-6", "Ready for Code Review"]);
  });

  it("pr_round + PR merged out-of-band → reviewing", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-7", "pr_round", "pr", { prNumber: 14 });
    state.pr = { number: 14, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
  });

  it("pr_round + PR closed/abandoned → teardown (no bogus Jira review transition)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-8", "pr_round", "pr", { prNumber: 15 });
    state.pr = { number: 15, state: "CLOSED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("closed");
    expect(calls.transitions).not.toContainEqual(["K-8", "Ready for Code Review"]);
    expect(calls.worktreeRemove).toContain("w1");
  });

  it("fix step 'working' but no commit progress past stall → attention (heartbeat)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H1", "fixing", "fix");
    store.upsertRunStep(run.id, "fix", { progressSig: "sha0", progressAt: 1000 });
    state.headSha = "sha0"; // HEAD frozen → no progress
    state.paneState = "working"; // claims to be working...
    setNow(1000 + 2701); // ...but stalled past stall_seconds
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("fix step commits advancing → heartbeat resets, stays fixing", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H2", "fixing", "fix");
    store.upsertRunStep(run.id, "fix", { progressSig: "sha0", progressAt: 1000 });
    state.headSha = "sha1"; // HEAD moved → progress
    state.paneState = "working";
    setNow(1000 + 2701);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("fixing");
    const fix = store.getRunStep(run.id, "fix")!;
    expect(fix.progressSig).toBe("sha1");
    expect(fix.progressAt).toBe(1000 + 2701);
    expect(calls.notify).toBe(0);
  });

  it("review step over budget + idle → attention", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-B1", "auto_review", "review");
    state.paneState = "idle";
    setNow(1000 + 1801); // past review_budget_seconds (1800)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("review step over budget but still working → extended (stays auto_review)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-B2", "auto_review", "review");
    state.paneState = "working";
    setNow(1000 + 1801);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("auto_review");
    expect(calls.notify).toBe(0);
  });

  it("step pane dead before signalling → re-spawns the agent", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-D1", "fixing", "fix", { paneId: "w1:dead" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:dead" });
    state.deadPanes.add("w1:dead"); // the fix pane is gone; the layout pane (w1:p1) is alive
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("fixing"); // still gating
    expect(calls.agentSend.length).toBe(1); // re-dispatched into the live layout pane
  });

  it("reviewing + merged PR → teardown (worktree remove + branch delete, ended merged)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-9", "reviewing", null, { watchDeadline: 99999 });
    state.pr = { number: 9, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(store.countActive("demo")).toBe(0);
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/K-9-s");
  });

  it("teardown falls back to workspace close + dir removal when worktree remove leaves the workspace", async () => {
    const { deps, store, state, worktree, calls } = build();
    state.workspaceExists = true; // herdr deregistered the git worktree but left the workspace
    const run = seed(store, worktree, "K-12", "reviewing", null, { watchDeadline: 99999 });
    state.pr = { number: 12, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(calls.worktreeRemove).toContain("w1"); // primary path attempted
    expect(calls.workspaceClose).toContain("w1"); // verified-still-present → closed directly
    expect(calls.rmrf).toContain(worktree); // orphaned checkout dir cleared
    expect(calls.branchDelete).toContain("fix/K-12-s"); // branch still deleted
  });

  it("reviewing + actionable new signature + idle → wakes resolver", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-10", "reviewing", null, { watchDeadline: 99999, lastThreadSig: "old" });
    state.pr = { number: 10, state: "OPEN", url: "u" };
    state.sig = { unresolved: 2, failing: 0, sig: "newsig" };
    state.paneState = "idle";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.length).toBe(1); // re-prompted the live pr-agent pane
    expect(store.getRun(run.id)!.lastThreadSig).toBe("newsig");
  });

  it("reviewing + still working → does not pile on", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-11", "reviewing", null, { watchDeadline: 99999, lastThreadSig: "old" });
    state.pr = { number: 11, state: "OPEN", url: "u" };
    state.sig = { unresolved: 1, failing: 0, sig: "newsig" };
    state.paneState = "working";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.length).toBe(0);
  });
});

describe("applyPendingFocus — focus follows the active step", () => {
  it("applies the focus shift when the user is viewing this worktree on a pipeline pane", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-1", "auto_review", "review", { focusPending: true });
    state.focusedPane = { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual(["w1:p1"]); // active step (review) pane brought to front
    expect(store.getRun(run.id)!.focusPending).toBe(false); // and the flag is cleared
  });

  it("defers (keeps pending, no focus) when the user is viewing a different worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-2", "auto_review", "review", { focusPending: true });
    state.focusedPane = { paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]); // never steal focus from another worktree
    expect(store.getRun(run.id)!.focusPending).toBe(true); // stored for later
  });

  it("defers when the user is on a non-pipeline pane in this worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-3", "auto_review", "review", { focusPending: true });
    state.focusedPane = { paneId: "w1:p9", workspaceId: "w1", tabId: "w1:t9", label: "editor" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]); // don't yank the user off an editor/scratch pane
    expect(store.getRun(run.id)!.focusPending).toBe(true);
  });

  it("defers when herdr is not frontmost (no focused pane)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-4", "auto_review", "review", { focusPending: true });
    state.focusedPane = null;
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(true);
  });

  it("applies a deferred focus on a later pass once the user navigates to the worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-5", "auto_review", "review", { focusPending: true });
    state.focusedPane = { paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!); // user elsewhere → deferred
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(true);
    state.focusedPane = { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" }; // navigates back
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual(["w1:p1"]); // now applied
    expect(store.getRun(run.id)!.focusPending).toBe(false);
  });

  it("does nothing when no focus is pending (never re-yanks the user)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "F-6", "auto_review", "review"); // focusPending defaults to false
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
  });

  it("clears a stale pending flag in a phase with no active step (reviewing)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "F-7", "reviewing", null, { focusPending: true });
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(false);
  });
});
