import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { applyPendingFocus, reconcileRepo, reconcileRun, requestHumanInput, withTickLock } from "../src/core/reconcile.ts";
import type { BeltRuntime, Deps, GitApi, GitHubApi, HerdrApi, SourceRuntime, WorkSource } from "../src/core/deps.ts";
import type { Config, Secrets, StepConfig } from "../src/config.ts";
import type { FocusedPane, HumanAskInput, HumanPollInput, HumanReply, MatchItem, Phase, PrInfo, ReviewSig, Ticket, WorkState } from "../src/types.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

interface FakeState {
  eligible: Ticket[]; // jira source's eligible items
  eligible2: Ticket[]; // the optional second (lm) source's eligible items
  pr: PrInfo | null;
  sig: ReviewSig;
  paneState: string;
  deadPanes: Set<string>; // panes herdr no longer tracks (paneAlive → false)
  headSha: string;
  sessionId: string | null;
  workspaceExists: boolean; // does the workspace still exist after a worktree remove?
  focusedPane: FocusedPane | null; // the pane the user is currently looking at
  humanReply: HumanReply | null; // source-native reply to a pending human question
}

/** A resolved belt step for the fakes. Budgets/heartbeat/opensPr mirror what config.ts derives for
 *  a work_to_pull_request belt; override via `opts` for custom-belt steps. */
const stepCfg = (name: string, opts: Partial<StepConfig> = {}): StepConfig => ({
  name,
  tab: name,
  pane: "agent",
  enginePrompt: `${name.toUpperCase()} prompt`,
  budgetSeconds: name === "fix" ? 5400 : name === "review" ? 1800 : 3600,
  heartbeat: name === "fix" || name === "pr",
  opensPr: name === "pr",
  ...opts,
});
const prSteps = (): StepConfig[] => [stepCfg("fix"), stepCfg("review"), stepCfg("pr")];

function build(opts: { multi?: boolean } = {}) {
  const worktree = mkdtempSync(join(tmpdir(), "cats-wt-"));
  tmps.push(worktree);
  let now = 1000;
  let uidN = 0; // deterministic per-claim branch suffix (u1, u2, …) so re-claims get distinct branches
  const store = new Store(openDb(":memory:"), () => now);
  const state: FakeState = { eligible: [], eligible2: [], pr: null, sig: { unresolved: 0, failing: 0, sig: "s0" }, paneState: "idle", deadPanes: new Set(), headSha: "sha0", sessionId: "sess-1", workspaceExists: false, focusedPane: { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" }, humanReply: null };
  const calls = {
    transitions: [] as [string, WorkState][],
    agentSend: [] as [string, string][],
    agentRename: [] as [string, string][],
    agentFocus: [] as string[],
    worktreeRemove: [] as string[],
    workspaceClose: [] as string[],
    rmrf: [] as string[],
    branchDelete: [] as string[],
    humanAsk: [] as HumanAskInput[],
    humanPoll: [] as HumanPollInput[],
    agentStart: 0,
    notify: 0,
  };
  const wrapJira = (t: Ticket): MatchItem => ({ sourceType: "jira", key: t.key, summary: t.summary, type: t.type, status: "To Do", labels: [], fields: {} });
  const wrapLm = (t: Ticket): MatchItem => ({ sourceType: "local_markdown", key: t.key, summary: t.summary, type: t.type, path: `/f/${t.key}.md`, filename: `${t.key}.md`, frontMatter: {}, body: "" });
  // Fake work sources; transitions record the CANONICAL WorkState (the canonical→backend mapping
  // lives inside the real JiraSource/LocalMarkdownSource, which these fakes stand in for).
  const jiraClient: WorkSource = {
    listEligible: async () => state.eligible.map(wrapJira),
    describe: async (key) => ({ key, summary: "Fix the thing", type: "Bug" }),
    transition: async (key, to) => { calls.transitions.push([key, to]); return true; },
    materialize: async (_key, memDir) => { mkdirSync(memDir, { recursive: true }); writeFileSync(join(memDir, "ticket.json"), "{}"); },
    askHuman: async (input) => { calls.humanAsk.push(input); return { externalId: `q-${input.questionId}`, externalCreatedAt: "2026-06-28T00:00:00.000+0000" }; },
    pollHumanReply: async (input) => { calls.humanPoll.push(input); return state.humanReply; },
    health: async () => {},
  };
  const sources: SourceRuntime[] = [{ name: "jira", type: "jira", client: jiraClient }];
  // The default belt: a work_to_pull_request belt on the jira source (today's fix→review→pr flow).
  const shipBelt: BeltRuntime = { name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, steps: prSteps(), watchPr: true };
  const belts: BeltRuntime[] = [shipBelt];

  let lmBelt: BeltRuntime | undefined;
  if (opts.multi) {
    const lmClient: WorkSource = {
      listEligible: async () => state.eligible2.map(wrapLm),
      describe: async (key) => ({ key, summary: "md work", type: "task" }),
      transition: async (key, to) => { calls.transitions.push([key, to]); return true; },
      materialize: async (_key, memDir) => { mkdirSync(memDir, { recursive: true }); writeFileSync(join(memDir, "task.md"), "# md"); },
      askHuman: async (input) => { calls.humanAsk.push(input); return { externalId: `q-${input.questionId}`, externalCreatedAt: "2026-06-28T00:00:00.000+0000" }; },
      pollHumanReply: async (input) => { calls.humanPoll.push(input); return state.humanReply; },
      health: async () => {},
    };
    sources.push({ name: "lm", type: "local_markdown", client: lmClient });
    lmBelt = { name: "lmship", beltType: "work_to_pull_request", source: "lm", priority: 2, workspaceName: "feature/{{work_id}}", steps: prSteps(), watchPr: true };
    belts.push(lmBelt);
  }

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
    agentRename: async (p, n) => { calls.agentRename.push([p, n]); },
    notify: async () => { calls.notify += 1; },
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
  const config: Config = {
    repoName: "demo",
    repo: { path: "/main-checkout", baseRef: "origin/master" },
    limits: { maxActive: 3, watchHours: 7, developBudgetSeconds: 5400, stallSeconds: 2700, reviewBudgetSeconds: 1800, prBudgetSeconds: 3600, stepBudgetSeconds: 3600, tickIntervalSeconds: 60, layoutWaitSeconds: 600 },
    sources: sources.map((s) => ({ name: s.name, type: s.type })),
    belts,
    guidance: undefined,
    paths: { configDir: "/c", repoDir: "/c/repos/demo", stateRoot: "/s", stateDir: "/s/demo", dbPath: "/s/db", logsDir: join(worktree, "logs") },
  };
  const deps: Deps = {
    config,
    secrets,
    store,
    ghRepo: "o/n",
    herdr,
    sources,
    resolveSource: (name) => sources.find((s) => s.name === name),
    belts,
    resolveBelt: (name) => belts.find((b) => b.name === name),
    github,
    git,
    log: () => {},
    now: () => now,
    uid: () => `u${++uidN}`,
    sleep: async () => {},
    rmrf: async (p) => { calls.rmrf.push(p); },
  };
  return { deps, store, state, calls, setNow: (n: number) => { now = n; }, worktree, shipBelt, lmBelt };
}

const ticket = (key: string, type = "Bug"): Ticket => ({ key, summary: "Fix the thing", type });

/** Seed an active run already parked at `phase`/`step`, with the active step's run_step spawned. */
function seed(
  store: Store,
  worktree: string,
  key: string,
  phase: Phase,
  step: string | null,
  extra: Record<string, unknown> = {},
  belt = "ship",
  workSource = "jira",
) {
  const run = store.createRun({ repo: "demo", workSource, belt, ticketKey: key, summary: "s", issueType: "Bug", branch: `fix/${key}-s` });
  store.updateRun(run.id, { phase, step, workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1", ...extra });
  if (step) store.upsertRunStep(run.id, step, { paneId: "w1:p1" });
  return store.getRun(run.id)!;
}

describe("reconcile pipeline (work_to_pull_request belt)", () => {
  it("claims an eligible ticket → running fix (worktree + fix agent + ticket fetch + In-dev transition)", async () => {
    const { deps, store, state, calls, worktree } = build();
    state.eligible = [ticket("K-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "K-1")!;
    expect(run.phase).toBe("running");
    expect(run.step).toBe("fix");
    expect(run.belt).toBe("ship");
    expect(run.branch).toBe("fix/K-1-fix-the-thing-u1"); // workspace_name render + per-run uid suffix
    expect(run.workspaceId).toBe("w1");
    expect(run.paneId).toBe("w1:p1"); // latest active pane = the fix agent
    expect(store.getRunStep(run.id, "fix")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // fix prompt dispatched
    expect(calls.transitions).toContainEqual(["K-1", "in_development"]);
    // materializeWork wrote the work doc the fix agent reads
    expect(existsSync(join(worktree, ".memory/herdr-factory/ticket.json"))).toBe(true);
  });

  it("a re-claimed ticket gets a fresh unique branch (so a prior merged PR isn't matched)", async () => {
    const { deps, store, state } = build();
    state.eligible = [ticket("K-RC")];
    await reconcileRepo(deps);
    const run1 = store.activeRunForTicket("demo", "jira", "K-RC")!;
    store.endRun(run1.id, "merged"); // prior attempt's PR merged + run ended
    state.eligible = [ticket("K-RC")]; // the ticket re-appears (re-labelled / moved back to To Do)
    await reconcileRepo(deps);
    const run2 = store.activeRunForTicket("demo", "jira", "K-RC")!;
    expect(run2.id).not.toBe(run1.id);
    // Same human-readable base, distinct per-run suffix — so prForBranch(run2.branch) can't match the
    // old merged PR that lives on run1.branch (the bug this fixes).
    expect(run1.branch).toBe("fix/K-RC-fix-the-thing-u1");
    expect(run2.branch).toBe("fix/K-RC-fix-the-thing-u2");
    expect(run2.branch).not.toBe(run1.branch);
  });

  it("claiming + configured pane not idle yet → waits (stays claiming, never spawns its own)", async () => {
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("W-1")];
    state.paneState = "working"; // the layout pane exists but its agent isn't idle yet
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-1")!;
    expect(run.phase).toBe("claiming"); // did NOT advance to running
    expect(calls.agentSend.length).toBe(0); // nothing dispatched yet
    expect(calls.agentStart).toBe(0); // and crucially did NOT spawn its own
    expect(store.getRunStep(run.id, "fix")?.paneId).toBeNull();
    expect(calls.transitions).not.toContainEqual(["W-1", "in_development"]);
  });

  it("claiming + configured pane never comes up past layout_wait → attention (no own pane)", async () => {
    const { deps, store, state, calls, setNow } = build();
    state.eligible = [ticket("W-2")];
    state.paneState = "working";
    await reconcileRepo(deps); // first pass begins the wait (fix.started_at = 1000)
    expect(store.activeRunForTicket("demo", "jira", "W-2")!.phase).toBe("claiming");
    setNow(1000 + 601); // past layout_wait_seconds (600)
    const run = store.activeRunForTicket("demo", "jira", "W-2")!;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
    expect(calls.agentStart).toBe(0); // never spawned its own
  });

  it("step with no tab/pane configured → spawns its own dedicated pane", async () => {
    const { deps, store, state, calls, shipBelt } = build();
    shipBelt.steps[0] = { ...shipBelt.steps[0]!, tab: undefined, pane: undefined };
    state.eligible = [ticket("S-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "S-1")!;
    expect(run.phase).toBe("running");
    expect(calls.agentStart).toBe(1); // spawned its own (the only path that creates a pane)
    expect(store.getRunStep(run.id, "fix")?.paneId).toBe("w1:p2"); // agentStart's pane
    expect(calls.agentSend.length).toBe(0); // prompt was passed as argv, not sent to a layout pane
    expect(calls.transitions).toContainEqual(["S-1", "in_development"]);
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

  it("running fix + fix agent not done → stays running fix (awaits step-done)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-3", "running", "fix");
    await reconcileRun(deps, run);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    expect(calls.agentSend.length).toBe(0); // alive + working, nothing to do
  });

  it("ask-human parks a step, polls the source, then automatically resumes with the reply", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-HITL", "running", "fix");

    const asked = await requestHumanInput(deps, run, "fix", "Which behavior should win when the flags conflict?");
    expect(asked.posted).toBe(true);
    expect(calls.humanAsk).toHaveLength(1);
    expect(calls.humanAsk[0]?.question).toContain("Which behavior");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(store.getRun(run.id)!.step).toBe("fix");

    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.humanPoll).toHaveLength(1);
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(store.getRun(run.id)!.step).toBe("fix");

    state.humanReply = { body: "Prefer the new flag and keep the legacy behavior as fallback.", externalId: "answer-1", author: "PM" };
    await reconcileRun(deps, store.getRun(run.id)!);

    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    expect(store.getHumanQuestion(asked.questionId)!.status).toBe("answered");
    const replyFile = join(worktree, ".memory/herdr-factory/human-replies/question-1.md");
    expect(readFileSync(replyFile, "utf8")).toContain("Prefer the new flag");
    expect(calls.agentSend.at(-1)?.[1]).toContain("Human guidance has arrived");
  });

  it("running fix + step-done fix → review (spawns review agent, no Jira move; wires the handoff)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-4", "running", "fix");
    store.markStepDone(run.id, "fix");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("review");
    expect(store.getRunStep(run.id, "review")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // review prompt dispatched
    // user is viewing this worktree on a belt pane (default focusedPane) → focus follows the
    // active step to the review pane, and the pending flag is cleared
    expect(calls.agentFocus).toContain("w1:p1");
    expect(got.focusPending).toBe(false);
    expect(calls.transitions).not.toContainEqual(["K-4", "in_review"]);
    // the rendered review prompt (written to the worktree) carries the step body, the prior
    // handoff pointer, and the engine-injected handover scaffold (belt + step-done footer).
    const body = readFileSync(join(worktree, ".memory/herdr-factory/prompt-review.md"), "utf8");
    expect(body).toContain("REVIEW prompt");
    expect(body).toContain("handoff-fix.md");
    expect(body).toContain("step-done K-4 review");
    expect(body).toContain("**ship** belt"); // scaffold names the belt
    // the prior step's pane + session id are captured at handoff and wired into the prompt
    expect(store.getRunStep(run.id, "fix")?.sessionId).toBe("sess-1");
    expect(body).toContain("w1:p1"); // prior pane
    expect(body).toContain("sess-1"); // prior session id
  });

  it("running review + step-done review → pr (spawns pr agent)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-5", "running", "review");
    store.markStepDone(run.id, "review");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("pr");
    expect(store.getRunStep(run.id, "pr")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1);
  });

  it("running pr + PR open + step-done pr → reviewing (review transition + deadline)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-6", "running", "pr", { prNumber: 13 });
    store.markStepDone(run.id, "pr");
    state.pr = { number: 13, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.step).toBeNull(); // no belt step active during the PR watch
    expect(got.watchDeadline).toBe(1000 + 7 * 3600);
    expect(calls.transitions).toContainEqual(["K-6", "in_review"]);
  });

  it("running pr + PR merged out-of-band → reviewing", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-7", "running", "pr", { prNumber: 14 });
    state.pr = { number: 14, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
  });

  it("running pr + PR closed/abandoned → teardown (no bogus Jira review transition)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-8", "running", "pr", { prNumber: 15 });
    state.pr = { number: 15, state: "CLOSED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("closed");
    expect(calls.transitions).not.toContainEqual(["K-8", "in_review"]);
    expect(calls.transitions).toContainEqual(["K-8", "aborted"]); // teardown writes the terminal state back
    expect(calls.worktreeRemove).toContain("w1");
  });

  it("fix step 'working' but no commit progress past stall → attention (heartbeat)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H1", "running", "fix");
    store.upsertRunStep(run.id, "fix", { progressSig: "sha0", progressAt: 1000 });
    state.headSha = "sha0"; // HEAD frozen → no progress
    state.paneState = "working"; // claims to be working...
    setNow(1000 + 2701); // ...but stalled past stall_seconds
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("fix step commits advancing → heartbeat resets, stays running fix", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H2", "running", "fix");
    store.upsertRunStep(run.id, "fix", { progressSig: "sha0", progressAt: 1000 });
    state.headSha = "sha1"; // HEAD moved → progress
    state.paneState = "working";
    setNow(1000 + 2701);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    const fix = store.getRunStep(run.id, "fix")!;
    expect(fix.progressSig).toBe("sha1");
    expect(fix.progressAt).toBe(1000 + 2701);
    expect(calls.notify).toBe(0);
  });

  it("review step over budget + idle → attention", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-B1", "running", "review");
    state.paneState = "idle";
    setNow(1000 + 1801); // past review budget (1800)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
    // the active pane is relabelled to a glaring attention marker (the persistent herdr cue)
    expect(calls.agentRename).toContainEqual(["w1:p1", "⚠ ATTENTION K-B1"]);
  });

  it("review step over budget but still working → extended (stays running)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-B2", "running", "review");
    state.paneState = "working";
    setNow(1000 + 1801);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(calls.notify).toBe(0);
  });

  it("step pane dead before signalling → re-spawns the agent", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-D1", "running", "fix", { paneId: "w1:dead" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:dead" });
    state.deadPanes.add("w1:dead"); // the fix pane is gone; the layout pane (w1:p1) is alive
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running"); // still gating
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
    expect(calls.transitions).toContainEqual(["K-9", "merged"]); // terminal state written back
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

describe("custom belt (agent-driven, no PR)", () => {
  // Swap the run onto a custom belt with steps research → propose, no PR watch.
  function customBelt(deps: Deps): BeltRuntime {
    const belt: BeltRuntime = {
      name: "gen",
      beltType: "custom",
      source: "jira",
      priority: 1,
      steps: [
        stepCfg("research", { budgetSeconds: 3600, heartbeat: false, opensPr: false }),
        stepCfg("propose", { budgetSeconds: 3600, heartbeat: false, opensPr: false }),
      ],
      watchPr: false,
    };
    deps.belts = [belt];
    deps.resolveBelt = (n) => (n === "gen" ? belt : undefined);
    return belt;
  }

  it("first step done → advances to the next custom step", async () => {
    const { deps, store, worktree, calls } = build();
    customBelt(deps);
    const run = seed(store, worktree, "G-1", "running", "research", {}, "gen");
    store.markStepDone(run.id, "research");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("propose");
    expect(calls.agentSend.length).toBe(1); // propose agent dispatched
  });

  it("last step done → teardown completed (no PR, no reviewing), writes terminal 'done'", async () => {
    const { deps, store, state, worktree, calls } = build();
    customBelt(deps);
    const run = seed(store, worktree, "G-2", "running", "propose", {}, "gen");
    store.markStepDone(run.id, "propose");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("completed");
    expect(state.pr).toBeNull(); // engine never queried GitHub for a custom belt
    expect(calls.transitions).toContainEqual(["G-2", "done"]); // custom-belt terminal write-back
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/G-2-s");
  });
});

describe("belt routing (match predicates, first match wins)", () => {
  it("claims each item with the first belt (by priority) whose match accepts it", async () => {
    const { deps, store, state } = build();
    const bugs: BeltRuntime = { name: "bugs", beltType: "work_to_pull_request", source: "jira", priority: 1, steps: prSteps(), watchPr: true, match: (ctx) => ctx.item.type === "Bug" };
    const rest: BeltRuntime = { name: "rest", beltType: "work_to_pull_request", source: "jira", priority: 2, steps: prSteps(), watchPr: true };
    deps.belts = [bugs, rest];
    deps.resolveBelt = (n) => deps.belts.find((b) => b.name === n);
    state.eligible = [ticket("K-bug", "Bug"), ticket("K-task", "Task")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-bug")?.belt).toBe("bugs"); // matched the bug belt
    expect(store.activeRunForTicket("demo", "jira", "K-task")?.belt).toBe("rest"); // fell through to the catch-all
  });

  it("an item no belt matches is left unclaimed", async () => {
    const { deps, store, state } = build();
    const onlyBugs: BeltRuntime = { name: "bugs", beltType: "work_to_pull_request", source: "jira", priority: 1, steps: prSteps(), watchPr: true, match: (ctx) => ctx.item.type === "Bug" };
    deps.belts = [onlyBugs];
    deps.resolveBelt = (n) => (n === "bugs" ? onlyBugs : undefined);
    state.eligible = [ticket("K-task", "Task")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-task")).toBeUndefined();
    expect(store.countActive("demo")).toBe(0);
  });
});

describe("multi-belt claim (Phase B)", () => {
  it("drains the higher-priority belt first under a shared cap", async () => {
    const { deps, store, state } = build({ multi: true });
    deps.config.limits.maxActive = 1;
    state.eligible = [ticket("J-1")]; // ship belt (jira), priority 1
    state.eligible2 = [ticket("M-1")]; // lmship belt (lm), priority 2
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
    expect(store.activeRunForTicket("demo", "jira", "J-1")).toBeTruthy(); // jira drained first
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeUndefined(); // no slot left for lm
  });

  it("the cap is global across belts (not per belt)", async () => {
    const { deps, store, state } = build({ multi: true });
    deps.config.limits.maxActive = 2;
    state.eligible = [ticket("J-1"), ticket("J-2")];
    state.eligible2 = [ticket("M-1")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(2); // both jira slots used; lm gets none
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeUndefined();
  });

  it("the same key in two sources is claimed as two distinct runs", async () => {
    const { deps, store, state } = build({ multi: true });
    deps.config.limits.maxActive = 5;
    state.eligible = [ticket("DUP")];
    state.eligible2 = [ticket("DUP")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(2);
    expect(store.activeRunForTicket("demo", "jira", "DUP")?.belt).toBe("ship");
    expect(store.activeRunForTicket("demo", "lm", "DUP")?.belt).toBe("lmship");
  });
});

describe("missing config resolution", () => {
  it("escalates an active run to attention when its source is gone from config", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "GONE-1", "running", "fix");
    deps.resolveSource = () => undefined; // simulate the source removed from config
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("escalates an active run to attention when its belt is gone from config", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "GONE-B", "running", "fix");
    deps.resolveBelt = () => undefined; // simulate the belt removed/renamed in config
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("a tearing_down run with a gone belt+source still completes local cleanup", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "GONE-2", "tearing_down", null);
    deps.resolveSource = () => undefined;
    deps.resolveBelt = () => undefined;
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(calls.worktreeRemove).toContain("w1"); // worktree still removed
    expect(calls.branchDelete).toContain("fix/GONE-2-s"); // branch still deleted
  });
});

describe("applyPendingFocus — focus follows the active step", () => {
  it("applies the focus shift when the user is viewing this worktree on a belt pane", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-1", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual(["w1:p1"]); // active step (review) pane brought to front
    expect(store.getRun(run.id)!.focusPending).toBe(false); // and the flag is cleared
  });

  it("defers (keeps pending, no focus) when the user is viewing a different worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-2", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]); // never steal focus from another worktree
    expect(store.getRun(run.id)!.focusPending).toBe(true); // stored for later
  });

  it("defers when the user is on a non-belt pane in this worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-3", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w1:p9", workspaceId: "w1", tabId: "w1:t9", label: "editor" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]); // don't yank the user off an editor/scratch pane
    expect(store.getRun(run.id)!.focusPending).toBe(true);
  });

  it("defers when herdr is not frontmost (no focused pane)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-4", "running", "review", { focusPending: true });
    state.focusedPane = null;
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(true);
  });

  it("applies a deferred focus on a later pass once the user navigates to the worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-5", "running", "review", { focusPending: true });
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
    const run = seed(store, worktree, "F-6", "running", "review"); // focusPending defaults to false
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
