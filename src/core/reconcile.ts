import type { Deps } from "./deps.ts";
import type { Outcome, Run, Ticket } from "../types.ts";
import { branchName } from "./branch.ts";
import { spawnWorker } from "./worker.ts";
import { spawnReview } from "./review.ts";
import { wakeResolver } from "./watch.ts";

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  switch (run.phase) {
    case "claiming":
      return reconcileClaiming(deps, run);
    case "developing":
      return reconcileDeveloping(deps, run);
    case "auto_review":
      return reconcileAutoReview(deps, run);
    case "reviewing":
      return reconcileReviewing(deps, run);
    case "tearing_down":
      return teardown(deps, run, "abandoned");
    case "attention":
    case "done":
      return;
  }
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

  // 2. spawn the worker (idempotent)
  await spawnWorker(deps, run);
  run = deps.store.getRun(run.id)!;

  // 3. transition Jira → In development, then advance phase
  try {
    const moved = await deps.jira.transition(run.ticketKey, deps.config.jira.statusInDev);
    if (moved) {
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: deps.config.jira.statusInDev } });
    }
    deps.store.updateRun(run.id, { phase: "developing" });
    deps.log("info", `${run.ticketKey}: developing on ${branch}`);
  } catch (e) {
    deps.log("warn", `${run.ticketKey}: In-development transition deferred: ${err(e)}`);
  }
}

/** Advance the worker's progress heartbeat when the branch HEAD moves; returns the
 *  (possibly refreshed) run. A moving HEAD = real work, so it resets the stall clock. */
async function trackProgress(deps: Deps, run: Run): Promise<Run> {
  if (!run.worktreePath) return run;
  const sha = await deps.git.headSha(run.worktreePath);
  if (!sha || sha === run.progressSig) return run;
  deps.store.updateRun(run.id, { progressSig: sha, progressAt: deps.now() });
  return deps.store.getRun(run.id)!;
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
  await deps.herdr.notify(`herdr-cats: ${run.ticketKey} needs attention`, opts.body).catch(() => {});
}

async function reconcileDeveloping(deps: Deps, run: Run): Promise<void> {
  // Heartbeat: a moving branch HEAD resets the stall clock, so a worker that keeps
  // committing is never flagged no matter how long it runs; a frozen HEAD past
  // `stallSeconds` counts as stalled even while the agent still reports "working".
  run = await trackProgress(deps, run);
  const stallMin = Math.round(deps.config.limits.stallSeconds / 60);
  const stalled =
    run.progressSig != null && run.progressAt != null && deps.now() - run.progressAt > deps.config.limits.stallSeconds;

  const pr = run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;

  if (pr && (pr.state === "OPEN" || pr.state === "MERGED")) {
    if (run.prNumber !== pr.number) {
      deps.store.updateRun(run.id, { prNumber: pr.number });
      run = deps.store.getRun(run.id)!;
    }
    const ready = run.workerDone || pr.state === "MERGED";
    if (ready) {
      // The optional review pass is a deterministic gate: spawn a dedicated review agent
      // and hold in `auto_review` until it signals `review-done`. No review config → go
      // straight to human review, exactly as before.
      if (deps.config.review) {
        await enterAutoReview(deps, run, pr.number);
      } else {
        await enterReviewing(deps, run, pr.number);
      }
      return;
    }

    // PR open but the worker hasn't signalled. Anchor a grace clock to PR-open (not run
    // start, so the window is the same regardless of how long development took). Escalate
    // if the worker has stalled, or the grace elapsed and the worker isn't actively working
    // — a "working" worker (e.g. its CI/bot round) is extended; idle/gone/blocked is stuck.
    if (!run.watchDeadline) {
      deps.store.updateRun(run.id, { watchDeadline: deps.now() + deps.config.limits.workerDoneGraceSeconds });
      deps.log("info", `${run.ticketKey}: PR #${pr.number} open; awaiting worker-done`);
      return;
    }
    const ws = run.paneId ? await deps.herdr.paneState(run.paneId) : "gone";
    const graceExpired = deps.now() > run.watchDeadline;
    if (stalled || (graceExpired && ws !== "working")) {
      const graceMin = Math.round(deps.config.limits.workerDoneGraceSeconds / 60);
      await escalateAttention(deps, run, {
        reason: stalled ? "worker_stalled" : "worker_done_grace",
        attentionReason: `PR #${pr.number} open but worker ${stalled ? "stalled" : "silent"} (worker: ${ws})`,
        body: stalled
          ? `PR #${pr.number} open but worker stalled ${stallMin}min — no new commits (worker: ${ws}).`
          : `PR #${pr.number} open but no worker-done after ${graceMin}min (worker: ${ws}).`,
        detail: { prNumber: pr.number, worker: ws },
      });
      return;
    }
    deps.log("info", `${run.ticketKey}: PR #${pr.number} open; awaiting worker-done (worker: ${ws})`);
    return;
  }

  // No PR yet. The develop budget bounds time-to-PR, but a worker still making progress
  // (committing) is extended so a legitimately long task isn't false-flagged. Escalate if
  // stalled, or past budget with the worker not actively working.
  const overBudget = deps.now() - run.createdAt > deps.config.limits.developBudgetSeconds;
  if (!stalled && !overBudget) return;
  const ws = run.paneId ? await deps.herdr.paneState(run.paneId) : "gone";
  if (!stalled && ws === "working") {
    deps.log("info", `${run.ticketKey}: past develop budget but worker still working — extending`);
    return;
  }
  const budgetMin = Math.round(deps.config.limits.developBudgetSeconds / 60);
  await escalateAttention(deps, run, {
    reason: stalled ? "worker_stalled" : "develop_budget",
    attentionReason: `${stalled ? "worker stalled" : "no PR within develop budget"} (worker: ${ws})`,
    body: stalled
      ? `No PR and worker stalled ${stallMin}min — no new commits (worker: ${ws}).`
      : `No PR after ${budgetMin}min (worker: ${ws}).`,
    detail: { worker: ws },
  });
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

/** Spawn the dedicated review agent and hold the run in the `auto_review` gate. */
async function enterAutoReview(deps: Deps, run: Run, prNumber: number): Promise<void> {
  const repo = deps.config.repoName;
  const pane = await spawnReview(deps, run);
  deps.store.updateRun(run.id, {
    phase: "auto_review",
    reviewPane: pane,
    reviewDone: false,
    watchDeadline: deps.now() + deps.config.limits.reviewBudgetSeconds,
  });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "review_spawned", detail: { paneId: pane, prNumber } });
  deps.log("info", `${run.ticketKey}: PR #${prNumber} ready -> auto_review (pane ${pane})`);
}

/** Gate the run until the review agent signals `review-done` (or the review budget elapses). */
async function reconcileAutoReview(deps: Deps, run: Run): Promise<void> {
  const repo = deps.config.repoName;
  const pr = run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;
  if (pr && run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });
  const prNumber = pr?.number ?? run.prNumber ?? 0;

  // PR resolved out from under us. A merged PR still flows through reviewing (consistent
  // with developing's merged handling); a CLOSED/abandoned PR goes straight to teardown —
  // routing it through enterReviewing would wrongly transition Jira to the review status.
  if (pr && pr.state === "CLOSED") return teardown(deps, run, "closed");
  if (pr && pr.state === "MERGED") return enterReviewing(deps, run, prNumber);

  if (run.reviewDone) {
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "review_done", detail: { paneId: run.reviewPane } });
    deps.log("info", `${run.ticketKey}: review-done -> reviewing`);
    return enterReviewing(deps, run, prNumber);
  }

  // Best-effort backstop: a stuck or silent review must not wedge the PR forever.
  if (run.watchDeadline && deps.now() > run.watchDeadline) {
    deps.log("warn", `${run.ticketKey}: review budget elapsed without review-done; proceeding to reviewing`);
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "review_done", detail: { timedOut: true } });
    return enterReviewing(deps, run, prNumber);
  }

  // Review agent died before signalling → re-spawn (idempotent recovery).
  if (!run.reviewPane || !(await deps.herdr.paneAlive(run.reviewPane))) {
    const pane = await spawnReview(deps, run);
    deps.store.updateRun(run.id, { reviewPane: pane });
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "review_spawned", detail: { paneId: pane, respawn: true } });
    deps.log("info", `${run.ticketKey}: review agent re-spawned (pane ${pane})`);
    return;
  }

  deps.log("info", `${run.ticketKey}: awaiting review-done (pane ${run.reviewPane})`);
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

  await wakeResolver(deps, run, pr.number);
  deps.store.updateRun(run.id, { lastThreadSig: sig.sig });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "resolver_woken", detail: { unresolved: sig.unresolved, failing: sig.failing } });
}

/** herdr owns workspace+dir+registration; we delete only the local branch. */
async function teardown(deps: Deps, run: Run, outcome: Outcome): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.updateRun(run.id, { phase: "tearing_down" });
  if (run.workspaceId) await deps.herdr.worktreeRemove(run.workspaceId);
  if (run.branch) await deps.git.branchDelete(deps.config.repo.path, run.branch);
  await deps.git.worktreePrune(deps.config.repo.path).catch(() => {});
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
