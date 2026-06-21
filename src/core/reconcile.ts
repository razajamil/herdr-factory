import type { Deps, SourceRuntime } from "./deps.ts";
import type { Outcome, Run, RunStep, StepName, Ticket } from "../types.ts";
import { outcomeToWorkState } from "../types.ts";
import { branchName } from "./branch.ts";
import { STEPS, type StepDescriptor, materializeWork, nextStep, spawnStep, stepForPhase } from "./step.ts";
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

  // Phase B — claim new work up to the cap, walking sources in priority order. The cap is
  // global across all sources; a higher-priority source drains its eligible work first.
  const active = deps.store.countActive(repo);
  let slots = deps.config.limits.maxActive - active;
  if (slots <= 0) {
    deps.log("info", `at capacity (${active}/${deps.config.limits.maxActive})`);
    deps.store.touchTick(repo);
    return;
  }

  let claimed = 0;
  for (const src of deps.sources) {
    if (slots <= 0) break;
    let eligible: Ticket[];
    try {
      eligible = await src.client.listEligible();
    } catch (e) {
      // One source's backend hiccup must not starve the others — log and move on.
      deps.log("warn", `${src.name}: eligible query failed: ${err(e)}`);
      continue;
    }
    for (const ticket of eligible) {
      if (slots <= 0) break;
      if (deps.store.activeRunForTicket(repo, src.name, ticket.key)) continue;
      // claim() creates the run row FIRST (which immediately counts toward countActive), so the
      // slot is consumed even if the rest of the claim throws — decrement before the try, or a
      // burst of claim failures in one pass would transiently spawn past maxActive.
      slots -= 1;
      try {
        await claim(deps, src, ticket);
        claimed += 1;
      } catch (e) {
        deps.log("error", `${src.name}/${ticket.key}: claim failed: ${err(e)}`);
      }
    }
  }
  deps.log("info", `claimed ${claimed}; active ${deps.store.countActive(repo)}/${deps.config.limits.maxActive}`);
  deps.store.touchTick(repo);
}

async function claim(deps: Deps, src: SourceRuntime, ticket: Ticket): Promise<void> {
  const repo = deps.config.repoName;
  const branch = branchName(ticket.key, ticket.type, ticket.summary, src.workspaceName);
  const run = deps.store.createRun({
    repo,
    workSource: src.name,
    ticketKey: ticket.key,
    summary: ticket.summary,
    issueType: ticket.type,
    branch,
  });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: ticket.key, type: "claimed", detail: { branch, source: src.name } });
  deps.log("info", `${src.name}/${ticket.key}: claimed -> ${branch}`);
  await reconcileRun(deps, run);
}

export async function reconcileRun(deps: Deps, run: Run): Promise<void> {
  // Resolve the run's source ONCE and thread it down — every site that needs per-source agents,
  // workspace_name, or the client reads it off `src` (no per-site re-lookup or null-guard).
  const src = deps.resolveSource(run.workSource);
  if (!src) {
    // The source was renamed/removed from config between claim and now. A tearing_down run must
    // still finish its local cleanup (worktree/branch) — the source client isn't needed for that.
    // Anything else can't be advanced: escalate to attention (idempotent) so an operator notices.
    if (run.phase === "tearing_down") {
      await teardown(deps, run, "abandoned", undefined);
    } else if (run.phase !== "attention" && run.phase !== "done") {
      deps.log("error", `${run.ticketKey}: work source "${run.workSource}" is not configured — escalating`);
      await escalateAttention(deps, run, {
        reason: "source_missing",
        attentionReason: `work source "${run.workSource}" not configured`,
        body: `${run.ticketKey}: its work source "${run.workSource}" is no longer in this repo's config — re-add it or tear the run down.`,
        detail: { workSource: run.workSource },
      });
    }
    return;
  }
  await dispatchPhase(deps, run, src);
  // Then, on every pass for every active run, try to apply any deferred focus shift. Doing
  // it here (not only on the tick that transitioned) is what lets a transition in an
  // unfocused worktree be picked up later, once the user navigates to it.
  const fresh = deps.store.getRun(run.id);
  if (fresh) await applyPendingFocus(deps, fresh);
}

async function dispatchPhase(deps: Deps, run: Run, src: SourceRuntime): Promise<void> {
  switch (run.phase) {
    case "claiming":
      return reconcileClaiming(deps, run, src);
    case "fixing":
    case "auto_review":
    case "pr_round": {
      const d = stepForPhase(run.phase);
      if (d) return reconcileStep(deps, run, src, d);
      return;
    }
    case "reviewing":
      return reconcileReviewing(deps, run, src);
    case "tearing_down":
      return teardown(deps, run, "abandoned", src);
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

async function reconcileClaiming(deps: Deps, run: Run, src: SourceRuntime): Promise<void> {
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

  // 2. materialize the work item (idempotent) and dispatch the fix agent. If the configured
  //    layout pane isn't up yet, stay in `claiming` and retry next tick (bounded; escalate to
  //    attention on timeout) — never spawn our own when a tab/pane is configured.
  if (!deps.store.getRunStep(run.id, "fix")?.paneId) {
    await materializeWork(deps, run, src);
    const res = await spawnStep(deps, run, src, "fix");
    if (res.status === "waiting") return handleLayoutWait(deps, run, src, "fix");
    run = deps.store.getRun(run.id)!;
  }

  // 3. Advance to fixing FIRST, then attempt the in-development transition best-effort. Gating
  //    the phase on the transition would pin the run in `claiming` forever if the transition
  //    keeps failing (auth/workflow) while its fix agent runs and finishes unobserved.
  deps.store.updateRun(run.id, { phase: "fixing" });
  deps.log("info", `${run.ticketKey}: fixing on ${branch}`);
  try {
    const moved = await src.client.transition(run.ticketKey, "in_development");
    if (moved) {
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: "in_development" } });
    }
  } catch (e) {
    deps.log("warn", `${run.ticketKey}: in-development transition deferred: ${err(e)}`);
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
  // Make it obvious in herdr: relabel the active pane. herdr won't let us set agent_status to
  // "blocked" (that's owned by the agent's own lifecycle hook), so a glaring pane label is the
  // most visible persistent cue — unlike the one-shot notification, it stays in the tab/pane list
  // until the run resolves (re-spawn renames it back; teardown removes the pane). Best-effort.
  if (run.paneId) await deps.herdr.agentRename(run.paneId, `⚠ ATTENTION ${run.ticketKey}`).catch(() => {});
  await deps.herdr.notify(`herdr-factory: ${run.ticketKey} needs attention`, opts.body).catch(() => {});
}

/** A step is waiting for its configured layout pane to come up (an idle agent in tab/pane).
 *  Stay put and retry next tick, but escalate to attention once we've waited past
 *  `layout_wait_seconds` (measured from the step row's started_at). Only steps that HAVE a
 *  tab/pane ever wait — steps without one spawn their own pane and never reach here. */
async function handleLayoutWait(deps: Deps, run: Run, src: SourceRuntime, step: StepName): Promise<void> {
  const cfg = src.agents[step];
  const where = `${cfg.tab}/${cfg.pane}`;
  const since = deps.store.getRunStep(run.id, step)?.startedAt ?? deps.now();
  const waited = deps.now() - since;
  if (waited <= deps.config.limits.layoutWaitSeconds) {
    deps.log("info", `${run.ticketKey}: ${step} waiting for layout pane ${where} (${waited}s/${deps.config.limits.layoutWaitSeconds}s)`);
    return;
  }
  await escalateAttention(deps, run, {
    reason: "layout_wait_timeout",
    attentionReason: `${step}: layout pane ${where} never became available`,
    body: `${step} step: configured pane ${where} didn't come up with an idle agent within ${Math.round(deps.config.limits.layoutWaitSeconds / 60)}min — is the herdr layout for this worktree running?`,
    detail: { step, tab: cfg.tab, pane: cfg.pane },
  });
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
async function reconcileStep(deps: Deps, run: Run, src: SourceRuntime, d: StepDescriptor): Promise<void> {
  const step = deps.store.getRunStep(run.id, d.name);

  // (Re)spawn if there's no live pane recorded for this step (first entry / crash gap). If
  // the step's configured layout pane isn't up yet, wait (bounded → attention) rather than
  // spawning our own.
  if (!step || !step.paneId) {
    const res = await spawnStep(deps, run, src, d.name);
    if (res.status === "waiting") await handleLayoutWait(deps, run, src, d.name);
    return;
  }
  // (Session id for on-demand query is captured at handoff time by spawnStep when the
  // NEXT step starts — no per-tick backfill needed here.)

  // The pr step opens the PR; fix/review run before any PR exists. Adopt only a live
  // (open/merged) PR's number, and abandon only on a CLOSED PR that is *ours* — a stale
  // CLOSED PR left on a reused branch name must not tear down a fresh attempt.
  const pr = d.name === "pr" && run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;
  if (pr && pr.state !== "CLOSED" && run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });
  if (pr && pr.state === "CLOSED" && pr.number === run.prNumber) return teardown(deps, run, "closed", src);
  const livePr = pr && pr.state !== "CLOSED" ? pr : null;

  // Advance when the agent signalled step-done (or its PR merged out from under us).
  if (step.done || livePr?.state === "MERGED") {
    const next = nextStep(d.name);
    if (next) {
      deps.store.updateRun(run.id, { phase: next.phase });
      deps.log("info", `${run.ticketKey}: ${d.name} done -> ${next.phase}`);
      await spawnStep(deps, run, src, next.name);
      return;
    }
    // Last step (pr) done → hand off to the human-review watch, but only with a real PR.
    // If the agent signalled done before a PR is visible (push lag / never opened), fall
    // through to the watchdog rather than wedging in `reviewing` with no PR to watch.
    if (livePr) return enterReviewing(deps, run, src, livePr.number);
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
    await spawnStep(deps, run, src, d.name);
    return;
  }
  deps.log("info", `${run.ticketKey}: awaiting step-done ${d.name} (pane ${step.paneId})`);
}

/** Transition the work item to its review state and move the run into the human-review watch. */
async function enterReviewing(deps: Deps, run: Run, src: SourceRuntime, prNumber: number): Promise<void> {
  const repo = deps.config.repoName;
  try {
    const moved = await src.client.transition(run.ticketKey, "in_review");
    if (moved) {
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: "in_review" } });
    }
  } catch (e) {
    deps.log("warn", `${run.ticketKey}: review transition deferred: ${err(e)}`);
  }
  deps.store.updateRun(run.id, { phase: "reviewing", watchDeadline: deps.now() + deps.config.limits.watchHours * 3600 });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "pr_opened", detail: { number: prNumber } });
  deps.log("info", `${run.ticketKey}: PR #${prNumber} -> reviewing`);
}

async function reconcileReviewing(deps: Deps, run: Run, src: SourceRuntime): Promise<void> {
  const repo = deps.config.repoName;
  const pr = run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;
  if (!pr) return;
  if (run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });

  if (pr.state === "MERGED") return teardown(deps, run, "merged", src);
  if (pr.state === "CLOSED") return teardown(deps, run, "closed", src);

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
async function teardown(deps: Deps, run: Run, outcome: Outcome, src: SourceRuntime | undefined): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.updateRun(run.id, { phase: "tearing_down" });

  // Write the terminal lifecycle state back to the source (best-effort, never blocks cleanup).
  // No-op for Jira (merged/aborted are unmapped → no network); records the merged/aborted label
  // for local_markdown so the file is never re-listed. Skipped entirely if the source is gone.
  if (src) {
    const finalState = outcomeToWorkState(outcome);
    try {
      const moved = await src.client.transition(run.ticketKey, finalState);
      if (moved) {
        deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: finalState } });
      }
    } catch (e) {
      deps.log("warn", `${run.ticketKey}: terminal (${finalState}) transition skipped: ${err(e)}`);
    }
  }

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

/** Manually claim + start a single item from a named source (the `claim` command). */
export async function claimTicket(deps: Deps, sourceName: string, ticketKey: string): Promise<void> {
  const src = deps.resolveSource(sourceName);
  if (!src) {
    throw new Error(`unknown work source "${sourceName}" — configured: ${deps.sources.map((s) => s.name).join(", ") || "(none)"}`);
  }
  if (deps.store.activeRunForTicket(deps.config.repoName, src.name, ticketKey)) {
    deps.log("warn", `${ticketKey}: already has an active run in source "${src.name}"`);
    return;
  }
  const ticket = await src.client.describe(ticketKey);
  await claim(deps, src, ticket);
}

/** Manually tear down an item's active run (the `teardown` command). With no `sourceName`,
 *  resolves the run by key across sources and errors if the key is ambiguous (active in >1). */
export async function teardownTicket(deps: Deps, ticketKey: string, sourceName?: string): Promise<void> {
  const repo = deps.config.repoName;
  let run: Run | undefined;
  if (sourceName) {
    run = deps.store.activeRunForTicket(repo, sourceName, ticketKey);
  } else {
    const runs = deps.store.activeRunsForKey(repo, ticketKey);
    if (runs.length > 1) {
      throw new Error(`${ticketKey}: active in multiple sources (${runs.map((r) => r.workSource).join(", ")}) — pass --source <name>`);
    }
    run = runs[0];
  }
  if (!run) {
    deps.log("warn", `${ticketKey}: no active run`);
    return;
  }
  // Resolve the source for the lifecycle write-back; undefined (removed source) → teardown skips it.
  await teardown(deps, run, "abandoned", deps.resolveSource(run.workSource));
}
