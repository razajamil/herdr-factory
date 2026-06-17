import type { Deps } from "./deps.ts";
import type { Outcome, Run, Ticket } from "../types.ts";
import { branchName } from "./branch.ts";
import { spawnWorker } from "./worker.ts";
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
  const branch = branchName(ticket.key, ticket.type, ticket.summary);
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

async function reconcileDeveloping(deps: Deps, run: Run): Promise<void> {
  const repo = deps.config.repoName;
  const pr = run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;

  if (pr && (pr.state === "OPEN" || pr.state === "MERGED")) {
    if (run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });
    const fresh = deps.store.getRun(run.id)!;
    const ready = fresh.workerDone || pr.state === "MERGED";
    if (ready) {
      try {
        const moved = await deps.jira.transition(run.ticketKey, deps.config.jira.statusReview);
        if (moved) {
          deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "transition", detail: { to: deps.config.jira.statusReview } });
        }
      } catch (e) {
        deps.log("warn", `${run.ticketKey}: review transition deferred: ${err(e)}`);
      }
      deps.store.updateRun(run.id, { phase: "reviewing", watchDeadline: deps.now() + deps.config.limits.watchHours * 3600 });
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "pr_opened", detail: { number: pr.number } });
      deps.log("info", `${run.ticketKey}: PR #${pr.number} ready -> reviewing`);
    } else {
      deps.log("info", `${run.ticketKey}: PR #${pr.number} open; awaiting worker-done`);
    }
    return;
  }

  // no PR yet — wall-clock budget is the stuck/dead-worker safety net
  if (deps.now() - run.createdAt > deps.config.limits.developBudgetSeconds) {
    const ws = run.paneId ? await deps.herdr.paneState(run.paneId) : "gone";
    deps.store.updateRun(run.id, { phase: "attention", attentionReason: `no PR within develop budget (worker: ${ws})` });
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "attention", detail: { reason: "develop_budget" } });
    await deps.herdr
      .notify(`herdr-cats: ${run.ticketKey} needs attention`, `No PR after ${Math.round(deps.config.limits.developBudgetSeconds / 60)}min (worker: ${ws}).`)
      .catch(() => {});
  }
}

async function reconcileReviewing(deps: Deps, run: Run): Promise<void> {
  const repo = deps.config.repoName;
  const pr = run.branch ? await deps.github.prForBranch(deps.ghRepo, run.branch) : null;
  if (!pr) return;
  if (run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });

  if (pr.state === "MERGED") return teardown(deps, run, "merged");
  if (pr.state === "CLOSED") return teardown(deps, run, "closed");

  if (run.watchDeadline && deps.now() > run.watchDeadline) {
    deps.store.updateRun(run.id, { phase: "attention", attentionReason: "review watch expired" });
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "attention", detail: { reason: "watch_timeout" } });
    await deps.herdr
      .notify(`herdr-cats: ${run.ticketKey} watch timed out`, `${deps.config.limits.watchHours}h review watch expired; PR left open.`)
      .catch(() => {});
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
