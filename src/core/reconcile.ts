import type { Deps } from "./deps.ts";
import type { Outcome, Run, RunStep, StepName, Ticket } from "../types.ts";
import { branchName } from "./branch.ts";
import { STEPS, type StepDescriptor, materializeTicket, nextStep, spawnStep, stepForPhase } from "./step.ts";
import { wakeResolver } from "./watch.ts";

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run `fn` under the per-repo single-instance tick lock; returns true if it ran, false if
 * the lock was already held (a tick is mid-flight). The TTL is floored well above the
 * longest healthy tick (which can block ~120s waiting on a layout pane) so a slow-but-live
 * tick can't have its lock stolen — it only auto-expires on a genuinely crashed tick.
 * Shared by the `tick` command and the `step-done` event-nudge.
 */
export async function withTickLock(deps: Deps, fn: () => Promise<void>): Promise<boolean> {
  const key = `tick:${deps.config.repoName}`;
  const owner = `pid:${process.pid}`;
  const ttl = Math.max(deps.config.limits.tickIntervalSeconds * 2, 300);
  if (!deps.store.acquireLock(key, owner, ttl)) return false;
  try {
    await fn();
  } finally {
    deps.store.releaseLock(key, owner);
  }
  return true;
}

/** One reconcile pass: advance active runs, then claim new work up to the cap. */
export async function reconcileRepo(deps: Deps): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.upsertRepo(repo, deps.config.repo.path, deps.config.repo.baseRef, deps.ghRepo);

  // Phase A — advance everything in flight.
  for (const run of deps.store.activeRuns(repo)) {
    try {
      await reconcileRun(deps, run);
    } catch (e) {
      deps.log("error", `${run.ticketKey}: ${err(e)}`);
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "error", detail: { message: err(e) } });
    }
  }

  // Phase B — claim new tickets up to the cap.
  const active = deps.store.countActive(repo);
  const slots = deps.config.limits.maxActive - active;
  if (slots <= 0) {
    deps.log("info", `at capacity (${active}/${deps.config.limits.maxActive})`);
    deps.store.touchTick(repo);
    return;
  }

  let eligible: Ticket[];
  try {
    eligible = await deps.jira.listEligible(deps.config.jira.board, deps.config.jira.label, deps.config.jira.statusTodo);
  } catch (e) {
    deps.log("warn", `eligible query failed: ${err(e)}`);
    deps.store.touchTick(repo);
    return;
  }

  let claimed = 0;
  for (const ticket of eligible) {
    if (claimed >= slots) break;
    if (deps.store.activeRunForTicket(repo, ticket.key)) continue;
    try {
      await claim(deps, ticket);
      claimed += 1;
    } catch (e) {
      deps.log("error", `${ticket.key}: claim failed: ${err(e)}`);
    }
  }
  deps.log("info", `claimed ${claimed}; active ${deps.store.countActive(repo)}/${deps.config.limits.maxActive}`);
  deps.store.touchTick(repo);
}

async function claim(deps: Deps, ticket: Ticket): Promise<void> {
  const repo = deps.config.repoName;
  const branch = branchName(ticket.key, ticket.type, ticket.summary, deps.config.workspaceName);
  const run = deps.store.createRun({
    repo,
    ticketKey: ticket.key,
    summary: ticket.summary,
    issueType: ticket.type,
    branch,
  });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: ticket.key, type: "claimed", detail: { branch } });
  deps.log("info", `${ticket.key}: claimed -> ${branch}`);
  await reconcileRun(deps, run);
}

export async function reconcileRun(deps: Deps, run: Run): Promise<void> {
  await dispatchPhase(deps, run);
  // Then, on every pass for every active run, try to apply any deferred focus shift. Doing
  // it here (not only on the tick that transitioned) is what lets a transition in an
  // unfocused worktree be picked up later, once the user navigates to it.
  const fresh = deps.store.getRun(run.id);
  if (fresh) await applyPendingFocus(deps, fresh);
}

async function dispatchPhase(deps: Deps, run: Run): Promise<void> {
  switch (run.phase) {
    case "claiming":
      return reconcileClaiming(deps, run);
    case "fixing":
    case "auto_review":
    case "pr_round": {
      const d = stepForPhase(run.phase);
      if (d) return reconcileStep(deps, run, d);
      return;
    }
    case "reviewing":
      return reconcileReviewing(deps, run);
    case "tearing_down":
      return teardown(deps, run, "abandoned");
    case "attention":
    case "done":
      return;
  }
}

/**
 * Apply a deferred focus shift, if one is pending. The active step's pane is brought to the
 * front ONLY when the user is currently viewing this run's worktree AND sitting on one of its
 * pipeline panes — so we never steal focus from another worktree, and never yank the user off
 * an unrelated (editor/server/scratch) pane. If those conditions don't hold, the pending flag
 * is left set and re-checked on later ticks. herdr exposes no focus-change event, so we poll
 * the focused pane here — but only when there's actually something pending (the cheap path
 * for the common case is a single boolean read).
 */
export async function applyPendingFocus(deps: Deps, run: Run): Promise<void> {
  if (!run.focusPending) return;
  const active = stepForPhase(run.phase);
  if (!active) {
    // No active pipeline step (reviewing/teardown/done) — nothing to focus; clear the flag.
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  const focused = await deps.herdr.focusedPane();
  if (!focused) return; // herdr not frontmost / no focused pane — keep pending
  if (focused.workspaceId !== run.workspaceId) return; // user is in another worktree — keep pending

  // "one of the predefined fix/review/pr panes" = the panes we've dispatched steps to for
  // this run. If the user is parked on some other pane, hold the focus rather than pull them.
  const pipelinePanes = STEPS.map((s) => deps.store.getRunStep(run.id, s.name)?.paneId).filter(Boolean);
  if (!pipelinePanes.includes(focused.paneId)) return; // on a non-pipeline pane — keep pending

  const target = deps.store.getRunStep(run.id, active.name)?.paneId;
  if (!target) {
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  await deps.herdr.agentFocus(target);
  deps.store.updateRun(run.id, { focusPending: false });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "focus_applied",
    detail: { step: active.name, paneId: target },
  });
}

async function reconcileClaiming(deps: Deps, run: Run): Promise<void> {
  const repo = deps.config.repoName;
  const branch = run.branch;
  if (!branch) throw new Error(`${run.ticketKey}: claiming without a branch`);

  // 1. ensure worktree
  if (!run.workspaceId || !(await deps.herdr.workspaceExists(run.workspaceId))) {
    const exists = await deps.git.branchExists(deps.config.repo.path, branch);
    const wt = exists
      ? await deps.herdr.worktreeOpen(deps.config.repo.path, branch)
      : await deps.herdr.worktreeCreate(deps.config.repo.path, branch, deps.config.repo.baseRef);
    deps.store.updateRun(run.id, { workspaceId: wt.workspaceId, worktreePath: wt.worktreePath });
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "worktree_created", detail: { workspaceId: wt.workspaceId } });
    run = deps.store.getRun(run.id)!;
    deps.log("info", `${run.ticketKey}: worktree ready (${wt.workspaceId})`);
  }

  // 2. fetch the ticket + images and spawn the fix agent (once)
  if (!deps.store.getRunStep(run.id, "fix")?.paneId) {
    await materializeTicket(deps, run);
    await spawnStep(deps, run, "fix");
    run = deps.store.getRun(run.id)!;
  }

  // 3. Advance to fixing FIRST, then attempt the Jira transition best-effort. Gating the
  //    phase on the transition would pin the run in `claiming` forever if the transition
  //    keeps failing (auth/workflow) while its fix agent runs and finishes unobserved.
  deps.store.updateRun(run.id, { phase: "fixing" });
  deps.log("info", `${run.ticketKey}: fixing on ${branch}`);
  try {
    const moved = await deps.jira.transition(run.ticketKey, deps.config.jira.statusInDev);
    if (moved) {
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: deps.config.jira.statusInDev } });
    }
  } catch (e) {
    deps.log("warn", `${run.ticketKey}: In-development transition deferred: ${err(e)}`);
  }
}

/** Advance the active step's heartbeat when the branch HEAD moves; returns the fresh
 *  step row. A moving HEAD = real work, so it resets that step's stall clock. */
async function trackStepProgress(deps: Deps, run: Run, step: StepName): Promise<RunStep> {
  const s = deps.store.getRunStep(run.id, step)!;
  if (!run.worktreePath) return s;
  const sha = await deps.git.headSha(run.worktreePath);
  if (!sha || sha === s.progressSig) return s;
  return deps.store.upsertRunStep(run.id, step, { progressSig: sha, progressAt: deps.now() });
}

/** Park a run for human attention: flip phase, record the reason, fire a notification. */
async function escalateAttention(
  deps: Deps,
  run: Run,
  opts: { reason: string; attentionReason: string; body: string; detail?: Record<string, unknown> },
): Promise<void> {
  deps.store.updateRun(run.id, { phase: "attention", attentionReason: opts.attentionReason });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "attention",
    detail: { reason: opts.reason, ...(opts.detail ?? {}) },
  });
  await deps.herdr.notify(`herdr-factory: ${run.ticketKey} needs attention`, opts.body).catch(() => {});
}

function budgetFor(deps: Deps, step: StepName): number {
  return step === "fix"
    ? deps.config.limits.developBudgetSeconds
    : step === "review"
      ? deps.config.limits.reviewBudgetSeconds
      : deps.config.limits.prBudgetSeconds;
}

/**
 * Generic per-step gate for fixing/auto_review/pr_round. Ensures the step's agent is
 * alive, advances on `step-done` (or a merged PR), else runs the watchdog: a commit-HEAD
 * stall heartbeat (fix/pr), a per-step budget, and liveness — escalating to `attention`
 * only when the agent isn't actively working. Re-spawns a dead pane idempotently.
 */
async function reconcileStep(deps: Deps, run: Run, d: StepDescriptor): Promise<void> {
  const step = deps.store.getRunStep(run.id, d.name);

  // (Re)spawn if there's no live pane recorded for this step (first entry / crash gap).
  if (!step || !step.paneId) {
    await spawnStep(deps, run, d.name);
    return;
  }
  // (Session id for on-demand query is captured at handoff time by spawnStep when the
  // NEXT step starts — no per-tick backfill needed here.)

  // The pr step opens the PR; fix/review run before any PR exists. Adopt only a live
  // (open/merged) PR's number, and abandon only on a CLOSED PR that is *ours* — a stale
  // CLOSED PR left on a reused branch name must not tear down a fresh attempt.
  const pr = d.name === "pr" && run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;
  if (pr && pr.state !== "CLOSED" && run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });
  if (pr && pr.state === "CLOSED" && pr.number === run.prNumber) return teardown(deps, run, "closed");
  const livePr = pr && pr.state !== "CLOSED" ? pr : null;

  // Advance when the agent signalled step-done (or its PR merged out from under us).
  if (step.done || livePr?.state === "MERGED") {
    const next = nextStep(d.name);
    if (next) {
      deps.store.updateRun(run.id, { phase: next.phase });
      deps.log("info", `${run.ticketKey}: ${d.name} done -> ${next.phase}`);
      await spawnStep(deps, run, next.name);
      return;
    }
    // Last step (pr) done → hand off to the human-review watch, but only with a real PR.
    // If the agent signalled done before a PR is visible (push lag / never opened), fall
    // through to the watchdog rather than wedging in `reviewing` with no PR to watch.
    if (livePr) return enterReviewing(deps, run, livePr.number);
  }

  // Not done — watchdog. Commit-HEAD heartbeat (fix/pr), per-step budget, and liveness.
  const active = d.heartbeat ? await trackStepProgress(deps, run, d.name) : step;
  const stalled =
    d.heartbeat &&
    active.progressSig != null &&
    active.progressAt != null &&
    deps.now() - active.progressAt > deps.config.limits.stallSeconds;
  const budget = budgetFor(deps, d.name);
  const overBudget = active.startedAt != null && deps.now() - active.startedAt > budget;

  if (stalled || overBudget) {
    const ws = active.paneId ? await deps.herdr.paneState(active.paneId) : "gone";
    if (!stalled && ws === "working") {
      deps.log("info", `${run.ticketKey}: ${d.name} past budget but still working — extending`);
      return;
    }
    await escalateAttention(deps, run, {
      reason: stalled ? "step_stalled" : "step_budget",
      attentionReason: `${d.name} step ${stalled ? "stalled" : "over budget"} (worker: ${ws})`,
      body: stalled
        ? `${d.name} step stalled ${Math.round(deps.config.limits.stallSeconds / 60)}min — no new commits (worker: ${ws}).`
        : `${d.name} step over ${Math.round(budget / 60)}min budget (worker: ${ws}).`,
      detail: { step: d.name, worker: ws },
    });
    return;
  }

  // Agent pane died before signalling → re-spawn (idempotent recovery). Re-check `done`
  // first: it may have flipped (step-done) after our earlier read, in which case the agent
  // finished and exited — don't relaunch a completed step into a duplicate agent.
  if (!(await deps.herdr.paneAlive(step.paneId))) {
    if (deps.store.getRunStep(run.id, d.name)?.done) return; // finished; the next tick advances
    deps.log("info", `${run.ticketKey}: ${d.name} pane gone — re-spawning`);
    await spawnStep(deps, run, d.name);
    return;
  }
  deps.log("info", `${run.ticketKey}: awaiting step-done ${d.name} (pane ${step.paneId})`);
}

/** Transition Jira to its review status and move the run into the human-review watch phase. */
async function enterReviewing(deps: Deps, run: Run, prNumber: number): Promise<void> {
  const repo = deps.config.repoName;
  try {
    const moved = await deps.jira.transition(run.ticketKey, deps.config.jira.statusReview);
    if (moved) {
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: deps.config.jira.statusReview } });
    }
  } catch (e) {
    deps.log("warn", `${run.ticketKey}: review transition deferred: ${err(e)}`);
  }
  deps.store.updateRun(run.id, { phase: "reviewing", watchDeadline: deps.now() + deps.config.limits.watchHours * 3600 });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "pr_opened", detail: { number: prNumber } });
  deps.log("info", `${run.ticketKey}: PR #${prNumber} -> reviewing`);
}

async function reconcileReviewing(deps: Deps, run: Run): Promise<void> {
  const repo = deps.config.repoName;
  const pr = run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;
  if (!pr) return;
  if (run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });

  if (pr.state === "MERGED") return teardown(deps, run, "merged");
  if (pr.state === "CLOSED") return teardown(deps, run, "closed");

  if (run.watchDeadline && deps.now() > run.watchDeadline) {
    await escalateAttention(deps, run, {
      reason: "watch_timeout",
      attentionReason: "review watch expired",
      body: `${deps.config.limits.watchHours}h review watch expired; PR left open.`,
    });
    return;
  }

  const sig = await deps.github.reviewSignature(deps.ghRepo, pr.number);
  if (sig.unresolved === 0 && sig.failing === 0) return; // nothing actionable
  if (sig.sig === run.lastThreadSig) return; // already handled this state

  const wstate = run.paneId ? await deps.herdr.paneState(run.paneId) : "gone";
  if (wstate === "working") return; // don't pile on mid-fix

  // Only record the signature as handled if the resolver actually launched — otherwise a
  // failed spawn would mark it done and never retry, silently dropping the review round.
  const woke = await wakeResolver(deps, run, pr.number);
  if (!woke) {
    deps.log("warn", `${run.ticketKey}: resolver spawn failed; retrying next tick`);
    return;
  }
  deps.store.updateRun(run.id, { lastThreadSig: sig.sig });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "resolver_woken", detail: { unresolved: sig.unresolved, failing: sig.failing } });
}

/**
 * herdr owns workspace+dir+registration; we delete only the local branch. Robust to a
 * partial `worktree remove`: herdr can deregister the git worktree but then error before
 * closing the workspace (and exits 0 with an error body), leaking the workspace + dir.
 * So: remove → verify the workspace is gone, else close it directly → clear the checkout
 * dir → prune the stale git registration → delete the branch (now safely not "checked out").
 */
async function teardown(deps: Deps, run: Run, outcome: Outcome): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.updateRun(run.id, { phase: "tearing_down" });

  if (run.workspaceId) {
    await deps.herdr.worktreeRemove(run.workspaceId);
    if (await deps.herdr.workspaceExists(run.workspaceId)) {
      deps.log("warn", `${run.ticketKey}: worktree remove left workspace ${run.workspaceId} — closing it directly`);
      await deps.herdr.workspaceClose(run.workspaceId);
    }
  }
  // The checkout dir can survive a partial remove. It's always a linked worktree under
  // herdr's worktrees dir, never the main checkout — guard anyway, then prune the now-stale
  // git registration so a re-claim of the same ticket starts clean.
  if (run.worktreePath && run.worktreePath !== deps.config.repo.path) {
    await deps.rmrf(run.worktreePath).catch(() => {});
  }
  await deps.git.worktreePrune(deps.config.repo.path).catch(() => {});
  if (run.branch) await deps.git.branchDelete(deps.config.repo.path, run.branch);

  deps.store.endRun(run.id, outcome);
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "torn_down", detail: { outcome } });
  deps.log("info", `${run.ticketKey}: torn down (${outcome})`);
}

// --- manual entry points (used by the CLI) ----------------------------------

/** Manually claim + start a single ticket (the `claim` command). */
export async function claimTicket(deps: Deps, ticketKey: string): Promise<void> {
  if (deps.store.activeRunForTicket(deps.config.repoName, ticketKey)) {
    deps.log("warn", `${ticketKey}: already has an active run`);
    return;
  }
  const issue = await deps.jira.getIssue(ticketKey);
  await claim(deps, { key: issue.key, summary: issue.fields.summary, type: issue.fields.issuetype?.name ?? "Task" });
}

/** Manually tear down a ticket's active run (the `teardown` command). */
export async function teardownTicket(deps: Deps, ticketKey: string): Promise<void> {
  const run = deps.store.activeRunForTicket(deps.config.repoName, ticketKey);
  if (!run) {
    deps.log("warn", `${ticketKey}: no active run`);
    return;
  }
  await teardown(deps, run, "abandoned");
}
