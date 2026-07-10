import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { classifyS3Error, uploadEvidence } from "../clients/evidence.ts";
import { runEffect } from "../runtime/effect.ts";
import { HerdrUnreachableError, type BeltRuntime, type Deps, type SourceRuntime } from "./deps.ts";
import type { StepConfig } from "../config.ts";
import type { HumanQuestion, HumanReply, MatchItem, Outcome, PrInfo, PrSnapshot, Run, RunStep, Ticket, TransitionIntent, WorkState } from "../types.ts";
import { outcomeToWorkState, StaleItemError, ticketOf } from "../types.ts";
import { branchName } from "./branch.ts";
import { firstStep, indexOfStep, materializeWork, MEMORY_DIR, nextStep, spawnStep, stepByName } from "./step.ts";
import { STEP_DESCRIPTORS } from "../steps/registry.ts";
import { wakeResolver } from "./watch.ts";
import { recordSourceAuthEvent, recordTick, recordTickDuration, recordTickLockSkipped, telemetryEvent, telemetrySpan } from "../telemetry/index.ts";
import { isSourceUnauthenticated, type SourceUnauthenticatedError } from "../auth/errors.ts";
import { getAuthFailure, markAuthNotified, recordAuthFailure, recordAuthOk } from "../auth/gate.ts";

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- work-source auth gate (resilience: pause + auto-resume, never haywire) -------------------
// A work source that can't authenticate (missing creds, or a live 401/403 → SourceUnauthenticatedError)
// must not silently vanish (the poll path used to degrade to []) or retry forever (the outbox). These
// two helpers record the gate state (src/auth/gate.ts — surfaced on the dashboard + doctor), notify the
// operator ONCE per source (throttled by attentionRenotifySeconds, mirroring the AWS-SSO evidence path),
// and — on recovery — re-queue the source's held write-backs so a restored session catches up promptly.
// Claiming/outbox/human-poll all call these; auto-resume falls out of the normal tick the moment a call
// to the source succeeds again.

/** Record + (throttled) notify that a work source is unauthenticated. Idempotent per source. */
async function noteSourceAuthFailure(deps: Deps, source: string, e: SourceUnauthenticatedError): Promise<void> {
  const repo = deps.config.repoName;
  const detail = e.hint ?? e.message;
  const wasDown = getAuthFailure(repo, source) !== undefined;
  recordAuthFailure(repo, source, { reason: e.reason, detail, now: deps.now() });
  if (!wasDown) {
    deps.log("warn", `${source}: work source not authenticated (${e.reason}) — pausing its claims + status write-backs until re-authenticated`);
    telemetryEvent("source.auth.unauthenticated", { "work.source": source, "auth.reason": e.reason });
    recordSourceAuthEvent({ "work.source": source, "auth.state": "unauthenticated", "auth.reason": e.reason });
  }
  const f = getAuthFailure(repo, source)!;
  const notifyDue = f.notifiedAt == null || deps.now() - f.notifiedAt >= deps.config.limits.attentionRenotifySeconds;
  if (notifyDue) {
    await deps.herdr
      .notify(
        `herdr-factory: ${source} not authenticated`,
        `Work source "${source}" can't authenticate: ${detail}. Its claims + status write-backs are paused; they resume automatically once it's authenticated again.`,
      )
      .catch(() => {});
    markAuthNotified(repo, source, deps.now());
  }
}

/** A source call SUCCEEDED — clear any auth failure. On recovery, re-queue held write-backs + notify. */
function noteSourceAuthRecovered(deps: Deps, source: string): void {
  const repo = deps.config.repoName;
  if (!recordAuthOk(repo, source)) return; // wasn't down — the common, hot path
  const requeued = deps.store.retryTransitionsForSource(repo, source);
  deps.log("info", `${source}: re-authenticated — resuming work${requeued ? ` (${requeued} held write-back(s) re-queued)` : ""}`);
  telemetryEvent("source.auth.recovered", { "work.source": source, "transition.requeued": requeued });
  recordSourceAuthEvent({ "work.source": source, "auth.state": "recovered" });
  void deps.herdr.notify(`herdr-factory: ${source} re-authenticated`, `Work source "${source}" is authenticated again — paused work is resuming.`).catch(() => {});
}

/** How long a step's pane must stay CONFIRMED absent before the reconciler respawns it. Two
 *  confirmed observations at least this far apart are required — long enough to ride out a herdr
 *  daemon restart, short enough that a genuinely dead pane restarts within ~a tick. */
const PANE_ABSENCE_CONFIRM_SECONDS = 45;

// --- source status write-backs (the transition outbox) -----------------------
// A transition is an INTENT persisted until the source confirms it, not a one-shot call: run
// phases advance regardless (a flaky Jira must never wedge the pipeline), and the outbox retries
// with backoff until the status of record converges. Without this, a dropped in_development
// transition left the ticket To Do — and since eligibility queries by status, the ticket would be
// claimed AGAIN after teardown and the merged work re-done.

/** One delivery attempt for an intent. `applied`/`noop` mark it delivered; `stale` (the item is
 *  gone — deleted/transferred; retrying cannot help) ALSO marks it delivered but stamps stale_at
 *  for the run-locked Phase A stale policy. This function is called LOCK-FREE from the Phase 0
 *  outbox flush, so it must never mutate the run itself — only the intent row + events.
 *  On a throw it records the attempt + backoff and returns false (throw = retry me). */
async function deliverTransition(deps: Deps, src: SourceRuntime, intent: TransitionIntent): Promise<boolean> {
  try {
    // The run's belt's pickup label, so a label-driven source can clear what listEligible filtered
    // on (INV-1; github_issues consumes the trigger label on in_development). Lock-free read — the
    // run row is only read here, never mutated. Undefined when the belt was renamed/removed (a
    // stranded run, INV-9) or the source has no label concept; the source treats that as "nothing
    // to clear". Terminal transitions don't use it (they strip state labels + close).
    const pickupLabel = deps.resolveBelt(deps.store.getRun(intent.runId)?.belt ?? null)?.label;
    const result = await src.client.transition(intent.ticketKey, intent.toState, pickupLabel);
    noteSourceAuthRecovered(deps, src.name); // delivery succeeded ⇒ auth is fine (clears any gate)
    switch (result.kind) {
      case "applied":
        deps.store.markTransitionDelivered(intent.id);
        deps.store.recordEvent({
          runId: intent.runId,
          repo: intent.repo,
          ticketKey: intent.ticketKey,
          type: "transition",
          detail: { to: intent.toState, attempts: intent.attempts },
        });
        break;
      case "noop":
        deps.store.markTransitionDelivered(intent.id); // already there / unmapped / automation won the race
        break;
      case "stale": {
        const detail = result.detail ?? "item no longer exists at the source";
        deps.store.markTransitionStale(intent.id, detail);
        deps.store.recordEvent({
          runId: intent.runId,
          repo: intent.repo,
          ticketKey: intent.ticketKey,
          type: "stale",
          detail: { to: intent.toState, reason: detail },
        });
        // An ended (or already tearing-down) run needs no policy reaction — consume the flag here
        // so Phase A never sees it. Reading the run lock-free is fine; only mutation is not.
        const run = deps.store.getRun(intent.runId);
        if (!run || run.endedAt !== null || run.phase === "done" || run.phase === "tearing_down") {
          deps.store.markTransitionStaleHandled(intent.id);
          deps.log("warn", `${intent.ticketKey}: ${intent.toState} write-back found the item gone (${detail}) — run already ${run?.phase ?? "gone"}, nothing to do`);
        } else {
          deps.log("warn", `${intent.ticketKey}: ${intent.toState} write-back found the item gone (${detail}) — stale policy will handle the run`);
        }
        break;
      }
    }
    return true;
  } catch (e) {
    // An auth failure here is a PAUSE, not a lost write-back: record + notify (once) so the operator
    // knows why the status isn't moving. The intent stays queued and re-queues promptly on recovery
    // (retryTransitionsForSource), rather than burning its exponential backoff out to an hour blindly.
    if (isSourceUnauthenticated(e)) await noteSourceAuthFailure(deps, src.name, e);
    const after = deps.store.recordTransitionAttempt(intent.id, err(e));
    deps.log(
      "warn",
      `${intent.ticketKey}: ${intent.toState} transition deferred (attempt ${after.attempts}, retry in ${after.nextAttemptAt - deps.now()}s): ${err(e)}`,
    );
    return false;
  }
}

/** Enqueue a transition intent and try to deliver it immediately (the common, healthy path — the
 *  status moves on the same tick it used to). Skips the immediate attempt when an EARLIER intent
 *  for the run is still undelivered: per-run delivery is strictly in-order, else a retried
 *  in_development could fire after in_review already landed and walk the source backward. */
async function requestTransition(deps: Deps, run: Run, src: SourceRuntime, to: WorkState): Promise<void> {
  const intent = deps.store.enqueueTransition({
    runId: run.id,
    repo: deps.config.repoName,
    workSource: src.name,
    ticketKey: run.ticketKey,
    toState: to,
  });
  if (deps.store.undeliveredTransitionBefore(run.id, intent.id)) {
    deps.log("warn", `${run.ticketKey}: ${to} transition queued behind an undelivered earlier transition`);
    return;
  }
  await deliverTransition(deps, src, intent);
}

/** Retry every due undelivered intent (in per-run order, stopping a run's chain at its first
 *  failure). Runs at the top of each tick so write-backs converge even while the repo is at
 *  capacity or the affected runs are parked/ended. */
export async function flushTransitionOutbox(deps: Deps): Promise<void> {
  const due = deps.store.dueTransitions(deps.config.repoName);
  for (const intent of due) {
    const src = deps.resolveSource(intent.workSource);
    if (!src) {
      // Source removed from config — the intent can never deliver; close it out loudly rather
      // than retrying forever against nothing.
      deps.store.recordTransitionAttempt(intent.id, `work source "${intent.workSource}" no longer configured`);
      deps.store.markTransitionDelivered(intent.id);
      deps.log("warn", `${intent.ticketKey}: dropping ${intent.toState} write-back — source "${intent.workSource}" is gone`);
      continue;
    }
    // In-order per run, checked against the DB (not just this pass): an earlier sibling that is
    // undelivered but backed off (not due) must still block this one — delivering out of order
    // would let a retried in_development land after in_review and walk the source backward.
    if (deps.store.undeliveredTransitionBefore(intent.runId, intent.id)) continue;
    await deliverTransition(deps, src, intent);
  }
}

/**
 * Retry every due evidence-upload intent (Phase 0, alongside the transition outbox). The evidence
 * agent published deterministic URLs into its handoff immediately; this lands the actual bytes in S3,
 * retrying with backoff until AWS accepts them — so an expired SSO session defers the upload instead of
 * losing it (the PR #6541 bug). LOCK-FREE like flushTransitionOutbox: it must never mutate a run (only
 * the evidence_uploads row + events + best-effort notify). A creds/token (`auth`) failure that keeps
 * recurring notifies the human to `aws sso login` (throttled per row via attentionRenotifySeconds).
 */
export async function flushEvidenceUploads(deps: Deps): Promise<void> {
  const repo = deps.config.repoName;
  const ev = deps.config.evidence;
  for (const job of deps.store.dueEvidenceUploads(repo)) {
    if (!ev) {
      deps.store.markEvidencePermanentFailed(job.id, "evidence config removed");
      continue;
    }
    // Best-effort drop policy: the bytes live in the worktree, which teardown removes. If the dir is
    // gone the upload can never land — stop retrying (this also covers the manual-teardown race).
    if (!existsSync(job.evidenceDir)) {
      deps.store.markEvidencePermanentFailed(job.id, "evidence dir gone (torn down before upload)");
      deps.log("warn", `${job.ticketKey}: evidence upload dropped — worktree removed before the upload landed`);
      continue;
    }
    try {
      const { files } = await uploadEvidence({ evidence: ev, dir: job.evidenceDir, prefix: job.keyPrefix });
      deps.store.markEvidenceDelivered(job.id);
      deps.store.recordEvent({ runId: job.runId, repo, ticketKey: job.ticketKey, type: "evidence_uploaded", detail: { files: files.length, prefix: job.keyPrefix, attempts: job.attempts } });
      deps.log("info", `${job.ticketKey}: evidence uploaded (${files.length} file(s)) after ${job.attempts} retr${job.attempts === 1 ? "y" : "ies"}`);
    } catch (e) {
      const c = classifyS3Error(e);
      // Notify on the FIRST failure, then throttle re-notifies by attentionRenotifySeconds (a null
      // notifiedAt means never-notified — must always fire, not be read as "notified at epoch 0").
      const notifyDue = job.notifiedAt == null || deps.now() - job.notifiedAt >= deps.config.limits.attentionRenotifySeconds;
      if (c.kind === "permanent") {
        deps.store.markEvidencePermanentFailed(job.id, c.reason);
        deps.store.recordEvent({ runId: job.runId, repo, ticketKey: job.ticketKey, type: "evidence_upload_failed", detail: { reason: c.reason } });
        if (notifyDue) {
          await deps.herdr.notify(`herdr-factory: ${job.ticketKey} evidence upload failed`, `Evidence upload can't proceed: ${c.reason}. Run \`herdr-factory --repo ${repo} doctor --deep\`; the published URLs won't resolve until it's fixed.`).catch(() => {});
          deps.store.markEvidenceNotified(job.id);
        }
      } else {
        const updated = deps.store.recordEvidenceAttempt(job.id, c.reason, c.kind);
        deps.log("warn", `${job.ticketKey}: evidence upload deferred (attempt ${updated?.attempts}): ${c.reason}`);
        if (c.kind === "auth" && notifyDue) {
          await deps.herdr.notify(`herdr-factory: AWS SSO expired`, `Evidence upload for ${job.ticketKey} is blocked on AWS creds — run \`aws sso login${ev.profile ? ` --profile ${ev.profile}` : ""}\`. It uploads automatically on the next tick.`).catch(() => {});
          deps.store.markEvidenceNotified(job.id);
        }
      }
    }
  }
}

/**
 * Acquire lock `key`, run `fn` under it with a keep-alive heartbeat, then release. Returns false
 * (fn not run) when the lock is already held.
 *
 * The heartbeat re-extends the TTL every ttl/3 while `fn` is in flight: the event loop stays free
 * during awaited subprocesses/fetches, so a long-but-ALIVE holder keeps its lock no matter how
 * slow the pass gets (at 50-100 active runs a healthy tick can legitimately outlive any fixed
 * TTL — under the old fixed-TTL scheme that expiry mid-tick reopened the concurrent-reconcile /
 * double-spawn window the lock exists to close). Extensions stop the moment the process dies —
 * crash, kill, or the supervisor's wedged-tick watchdog restart — and the TTL then expires
 * normally, so a dead holder still recovers within one TTL. The owner token is unique per
 * ACQUISITION (not per process): two contexts in one process can never mistake each other's hold
 * for their own.
 */
let lockSeq = 0; // per-process acquisition counter (deps.uid() is reserved for branch suffixes)

async function withHeartbeatLock(deps: Deps, key: string, ttlSec: number, fn: () => Promise<void>): Promise<boolean> {
  const owner = `pid:${process.pid}:${++lockSeq}`;
  if (!deps.store.acquireLock(key, owner, ttlSec)) return false;
  const timer = setInterval(
    () => {
      try {
        deps.store.extendLock(key, owner, ttlSec);
      } catch {
        /* next beat retries; TTL expiry is the backstop */
      }
    },
    Math.max(5_000, (ttlSec * 1000) / 3),
  );
  try {
    await fn();
  } finally {
    clearInterval(timer);
    deps.store.releaseLock(key, owner);
  }
  return true;
}

/**
 * Run `fn` under the per-repo single-instance tick lock (heartbeat-extended; see
 * withHeartbeatLock); returns true if it ran, false if a tick is already mid-flight.
 * Shared by the `tick` command and the server's periodic loop.
 */
export async function withTickLock(deps: Deps, fn: () => Promise<void>): Promise<boolean> {
  return telemetrySpan("tick.lock", { repo: deps.config.repoName }, async (span) => {
    const ttl = Math.max(deps.config.limits.tickIntervalSeconds * 2, 300);
    const startedAt = Date.now();
    const ran = await withHeartbeatLock(deps, `tick:${deps.config.repoName}`, ttl, fn);
    span.setAttribute("lock.acquired", ran);
    if (!ran) {
      recordTick(false, { repo: deps.config.repoName, "tick.skip_reason": "lock_held" });
      recordTickLockSkipped({ repo: deps.config.repoName });
      return false;
    }
    recordTickDuration(Date.now() - startedAt, { repo: deps.config.repoName });
    recordTick(true, { repo: deps.config.repoName });
    return true;
  });
}

/** Per-run lock TTL. A single run's reconcile is bounded by the item-1 exec/fetch timeouts;
 *  the heartbeat covers the legitimately-slow tail (worktree create, attachment downloads). */
const RUN_LOCK_TTL_SECONDS = 300;

/**
 * Run `fn` under `run:<id>` — the mutual exclusion for everything that MUTATES one run: the
 * tick's Phase A reconcile of that run, and the event nudges (step-done / bounce / ask-human /
 * resume). Per-run locks are what let a nudge land IMMEDIATELY while a long tick is mid-pass
 * (the old design serialized nudges behind the whole repo-wide tick lock, so at scale every
 * advance degraded to tick latency): a nudge only contends with work on its own run.
 * Returns false (fn not run) when the run is being reconciled by someone else right now.
 */
export async function withRunLock(deps: Deps, runId: number, fn: () => Promise<void>): Promise<boolean> {
  return telemetrySpan("run.lock", { repo: deps.config.repoName, "run.id": runId }, async (span) => {
    const ran = await withHeartbeatLock(deps, `run:${runId}`, RUN_LOCK_TTL_SECONDS, fn);
    span.setAttribute("lock.acquired", ran);
    return ran;
  });
}

/**
 * withRunLock + a bounded wait (~15s), returning `fn`'s result. For the NON-monotonic run
 * mutations that must not be dropped on contention: a bounce rewinds `run.step` AND re-dispatches
 * a pane, ask-human flips the phase to waiting_for_human, resume un-parks — a concurrent
 * reconcile working from a stale pre-mutation snapshot would respawn/double-spawn the wrong step
 * or overwrite the phase flip (the old unserialized ask-human could orphan its question forever).
 * step-done stays fire-and-forget (a monotonic flag whose stale read only defers an idempotent
 * advance). Returns { ran: false } when the run stays busy past the wait — caller reports "busy".
 */
export async function withRunLockWaiting<T>(
  deps: Deps,
  runId: number,
  fn: () => Promise<T>,
  opts: { tries?: number; delayMs?: number } = {},
): Promise<{ ran: boolean; result?: T }> {
  const tries = opts.tries ?? 30;
  const delayMs = opts.delayMs ?? 500;
  for (let i = 0; i < tries; i++) {
    let result: T | undefined;
    const ran = await withRunLock(deps, runId, async () => {
      result = await fn();
    });
    if (ran) return { ran: true, result };
    await deps.sleep(delayMs);
  }
  return { ran: false };
}

/** Per-tick shared context. `prSnapshots` is the batched GitHub fetch for every watched PR
 *  (reviewing/attention) — one GraphQL request replaces 3 gh calls per run per tick. Undefined ⇒
 *  the batch fetch failed or the caller is a single-run nudge; per-run fallback polling applies. */
export interface TickCtx {
  prSnapshots?: Map<number, PrSnapshot>;
}

/** Bulk-fetch PR state + review signatures for every run that watches a PR by number. */
async function fetchPrSnapshots(deps: Deps, runs: Run[]): Promise<Map<number, PrSnapshot> | undefined> {
  const numbers = [
    ...new Set(
      runs
        .filter((r) => (r.phase === "reviewing" || r.phase === "attention") && r.prNumber != null)
        .map((r) => r.prNumber!),
    ),
  ];
  if (numbers.length === 0) return new Map();
  try {
    return await deps.github.prSnapshots(deps.ghRepo, numbers);
  } catch (e) {
    deps.log("warn", `batched PR fetch failed (${numbers.length} PRs) — falling back to per-run polling: ${err(e)}`);
    return undefined;
  }
}

/** One reconcile pass: advance active runs, then claim new work up to the cap. */
export async function reconcileRepo(deps: Deps): Promise<void> {
  return telemetrySpan("reconcile.repo", { repo: deps.config.repoName }, () => reconcileRepoImpl(deps));
}

async function reconcileRepoImpl(deps: Deps): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.upsertRepo(repo, deps.config.repo.path, deps.config.repo.baseRef, deps.ghRepo);

  // Phase 0 — retry undelivered source status write-backs (before anything else, so they
  // converge even at capacity and for already-ended runs).
  try {
    await flushTransitionOutbox(deps);
  } catch (e) {
    deps.log("error", `transition outbox flush failed: ${err(e)}`);
  }
  // Phase 0 (cont.) — retry undelivered evidence-upload intents (durable S3 upload; survives SSO expiry).
  try {
    await flushEvidenceUploads(deps);
  } catch (e) {
    deps.log("error", `evidence upload flush failed: ${err(e)}`);
  }

  // Phase A — advance everything in flight, in parallel with bounded concurrency (most of a
  // run's reconcile is subprocess/network wait, so the wall-clock of a pass stops growing
  // linearly with the active-run count). Each run is guarded by its own run lock: an event nudge
  // (step-done/bounce/ask-human/resume) holding a run just skips it this pass — that run is
  // being advanced anyway — and nudges for OTHER runs land mid-pass unimpeded.
  const activeRuns = deps.store.activeRuns(repo);
  const ctx: TickCtx = { prSnapshots: await fetchPrSnapshots(deps, activeRuns) };
  await runEffect(
    Effect.forEach(
      activeRuns,
      (run) =>
        Effect.tryPromise({
          try: async () => {
            const ran = await withRunLock(deps, run.id, () => reconcileRun(deps, run, ctx));
            if (!ran) deps.log("info", `${run.ticketKey}: busy (nudge in flight) — skipped this pass`);
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              deps.log("error", `${run.ticketKey}: ${err(e)}`);
              deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "error", detail: { message: err(e) } });
            }),
          ),
        ),
      { concurrency: deps.config.limits.reconcileConcurrency, discard: true },
    ),
  );

  // Phase B — claim new work up to the cap, walking BELTS in priority order. The cap is global
  // across all belts; a higher-priority belt drains its eligible work first, and the FIRST belt
  // whose `match` predicate accepts an item claims it (first match wins). Capacity counts only
  // WORKING runs — parked runs (attention / waiting_for_human) keep their worktree but no agent
  // is consuming machine resources, and a pile of them must not starve the belt.
  const occupying = deps.store.countOccupying(repo);
  // Active-but-not-occupying: the parks (attention, waiting_for_human) plus idle PR-watches
  // (reviewing with no active resolver). None hold a slot; all still own a worktree on disk.
  const idleOrParked = deps.store.countActive(repo) - occupying;
  let slots = deps.config.limits.maxActiveWorkspaces - occupying;
  if (slots <= 0) {
    deps.log("info", `at capacity (${occupying}/${deps.config.limits.maxActiveWorkspaces} working, ${idleOrParked} idle/parked)`);
    deps.store.touchTick(repo);
    return;
  }
  // Admission control: each claim is a burst of real work (worktree checkout, ticket + attachment
  // materialize, status transition ≈ 5+ source calls). Capping claims per pass smooths a cold
  // start with a big backlog into successive ticks instead of one source-hammering mega-tick.
  if (slots > deps.config.limits.maxClaimsPerTick) slots = deps.config.limits.maxClaimsPerTick;

  // One eligible query per (source, pickup label) per pass: a source feeding several belts is
  // fetched once PER DISTINCT label (label-driven sources filter server-side on it, so different
  // belts see disjoint items; a label-less source ignores it and collapses to one fetch).
  const eligibleCache = new Map<string, MatchItem[]>();
  const getEligible = async (src: SourceRuntime, label: string | undefined): Promise<MatchItem[]> => {
    const cacheKey = `${src.name}\0${label ?? ""}`;
    const cached = eligibleCache.get(cacheKey);
    if (cached) return cached;
    let items: MatchItem[];
    try {
      items = await src.client.listEligible(label);
      noteSourceAuthRecovered(deps, src.name); // a successful poll ⇒ auth is fine (clears any gate)
    } catch (e) {
      // A source that can't authenticate is PAUSED, not broken: record + notify (once) and skip its
      // claims this tick — it auto-resumes when a later poll succeeds. Any other backend hiccup must
      // still not starve the other sources, so it also degrades to [] (just logged, not gated).
      if (isSourceUnauthenticated(e)) await noteSourceAuthFailure(deps, src.name, e);
      else deps.log("warn", `${src.name}: eligible query failed: ${err(e)}`);
      items = [];
    }
    eligibleCache.set(cacheKey, items);
    return items;
  };

  let claimed = 0;
  for (const belt of deps.belts) {
    if (slots <= 0) break;
    const src = deps.resolveSource(belt.source);
    if (!src) {
      deps.log("warn", `belt ${belt.name}: source "${belt.source}" not configured — skipping`);
      continue;
    }
    for (const item of await getEligible(src, belt.label)) {
      if (slots <= 0) break;
      // Dedup is per (source, key): once any belt has an active run for the item, no other belt
      // claims it — which is exactly what makes "first matching belt wins" hold across the pass.
      if (deps.store.activeRunForTicket(repo, src.name, item.key)) continue;
      // An undelivered write-back means this item's source status is known-stale — its "eligible"
      // listing can't be trusted (e.g. a merged run whose transition never landed would be
      // re-claimed here and the work re-done). Let the outbox converge first.
      if (deps.store.pendingTransitionForKey(repo, src.name, item.key)) {
        deps.log("warn", `${item.key}: skipping claim — a status write-back to "${src.name}" is still pending`);
        continue;
      }
      if (belt.match) {
        let accepted: boolean;
        try {
          accepted = !!(await belt.match({ item, source: { name: src.name, type: src.type } }));
        } catch (e) {
          deps.log("warn", `belt ${belt.name}: match predicate threw for ${item.key}: ${err(e)}`);
          continue;
        }
        if (!accepted) continue;
      }
      // claim() creates the run row FIRST (which immediately counts toward countActive), so the
      // slot is consumed even if the rest of the claim throws — decrement before the try, or a
      // burst of claim failures in one pass would transiently spawn past maxActive.
      slots -= 1;
      try {
        await claim(deps, belt, src, ticketOf(item));
        claimed += 1;
      } catch (e) {
        deps.log("error", `${belt.name}/${item.key}: claim failed: ${err(e)}`);
      }
    }
  }
  deps.log("info", `claimed ${claimed}; working ${deps.store.countOccupying(repo)}/${deps.config.limits.maxActiveWorkspaces}, idle/parked ${idleOrParked}`);
  deps.store.touchTick(repo);
}

async function claim(deps: Deps, belt: BeltRuntime, src: SourceRuntime, ticket: Ticket): Promise<void> {
  return telemetrySpan(
    "reconcile.claim",
    { repo: deps.config.repoName, "work.source": src.name, belt: belt.name, "work.key": ticket.key, "work.type": ticket.type },
    () => claimImpl(deps, belt, src, ticket),
  );
}

async function claimImpl(deps: Deps, belt: BeltRuntime, src: SourceRuntime, ticket: Ticket): Promise<void> {
  const repo = deps.config.repoName;
  // The per-run uid makes the branch unique to THIS attempt, so a re-claimed ticket doesn't reuse a
  // branch name whose prior PR was already merged (which the pr step would otherwise treat as done).
  const branch = branchName(ticket.key, ticket.type, ticket.summary, belt.workspaceName, deps.uid());
  const run = deps.store.createRun({
    repo,
    workSource: src.name,
    belt: belt.name,
    ticketKey: ticket.key,
    summary: ticket.summary,
    issueType: ticket.type,
    branch,
  });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: ticket.key, type: "claimed", detail: { branch, source: src.name, belt: belt.name } });
  deps.log("info", `${belt.name}/${ticket.key}: claimed -> ${branch}`);
  // Under the run lock like every other mutation of this run (uncontended for a fresh claim; the
  // guard matters once its first agent exists and can nudge).
  await withRunLock(deps, run.id, () => reconcileRun(deps, run));
}

export async function reconcileRun(deps: Deps, run: Run, ctx: TickCtx = {}): Promise<void> {
  return telemetrySpan(
    "reconcile.run",
    {
      repo: deps.config.repoName,
      "run.id": run.id,
      "work.key": run.ticketKey,
      "work.source": run.workSource ?? undefined,
      belt: run.belt ?? undefined,
      phase: run.phase,
      step: run.step ?? undefined,
    },
    () => reconcileRunImpl(deps, run, ctx),
  );
}

async function reconcileRunImpl(deps: Deps, run: Run, ctx: TickCtx): Promise<void> {
  // Resolve the run's source + belt ONCE and thread them down. The belt carries the step sequence
  // + lifecycle; the source materializes the work doc and owns the lifecycle write-back.
  const src = deps.resolveSource(run.workSource);
  const belt = deps.resolveBelt(run.belt);
  if (!src || !belt) {
    // Config changed between claim and now (source/belt renamed or removed). A tearing_down run
    // must still finish its local cleanup (worktree/branch) — neither is needed for that. Anything
    // else can't be advanced: escalate to attention (idempotent) so an operator notices.
    if (run.phase === "tearing_down") {
      await teardown(deps, run, run.outcome ?? "abandoned", src);
    } else if (run.phase !== "attention" && run.phase !== "done") {
      const what = !belt ? `belt "${run.belt}"` : `work source "${run.workSource}"`;
      deps.log("error", `${run.ticketKey}: ${what} is not configured — escalating`);
      await escalateAttention(deps, run, {
        reason: !belt ? "belt_missing" : "source_missing",
        attentionReason: `${what} not configured`,
        body: `${run.ticketKey}: its ${what} is no longer in this repo's config — re-add it or tear the run down.`,
        detail: { belt: run.belt, workSource: run.workSource },
      });
    }
    return;
  }
  // Stale policy (run-locked half of the two-phase handling — the lock-free outbox flush only
  // stamped stale_at): a write-back found this run's item GONE at the source. Consume the flag
  // exactly once, then abort or park per policy.
  if (run.phase !== "done" && run.phase !== "tearing_down") {
    const stale = deps.store.unhandledStaleIntentForRun(run.id);
    if (stale) {
      deps.store.markTransitionStaleHandled(stale.id);
      const why = stale.lastError ?? "item no longer exists at the source";
      // Abort vs park keys on the RUN'S progress, not just which intent went stale: a claim-time
      // in_development intent can deliver stale long after the run advanced (the outbox backs
      // off up to 1h while phases move on) — destroying a reviewing run's worktree with an open
      // PR is exactly what the park branch exists to prevent.
      const preWork = stale.toState === "in_development" && run.prNumber == null && (run.phase === "claiming" || run.phase === "running");
      if (preWork) {
        // The claim write-back found the item gone: a human deleted/closed it during claim —
        // "don't do this work". Abort promptly, bounding further token spend (the first agent may
        // already be running; the claim transition fires after the first spawn). Teardown's own
        // `aborted` intent going stale again lands in the ended-run path — no double-fire.
        deps.log("warn", `${run.ticketKey}: aborting — ${why}`);
        await deps.herdr.notify(`herdr-factory: ${run.ticketKey} aborted`, `Work item gone at the source (${why}) — run aborted.`).catch(() => {});
        await teardown(deps, run, "abandoned", src);
      } else {
        // Mid-flight (e.g. in_review): the work exists — a PR may be up — so park for a human
        // instead of destroying it. No source note: the item it would go to is gone.
        await escalateAttention(deps, run, {
          reason: "source_item_stale",
          attentionReason: `work item gone at the source (${why})`,
          body: `${run.ticketKey}: the ${stale.toState} write-back found the item gone (${why}). Resume to continue anyway, or tear the run down.`,
          detail: { toState: stale.toState, why },
          skipSourceNote: true,
        });
      }
      return;
    }
  }
  await dispatchPhase(deps, run, belt, src, ctx);
  // Then, on every pass for every active run, try to apply any deferred focus shift. Doing
  // it here (not only on the tick that transitioned) is what lets a transition in an
  // unfocused worktree be picked up later, once the user navigates to it.
  const fresh = deps.store.getRun(run.id);
  if (fresh) await applyPendingFocus(deps, fresh);
}

async function dispatchPhase(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  return telemetrySpan(
    `reconcile.phase.${run.phase}`,
    {
      repo: deps.config.repoName,
      "run.id": run.id,
      "work.key": run.ticketKey,
      "work.source": src.name,
      belt: belt.name,
      phase: run.phase,
      step: run.step ?? undefined,
    },
    async () => {
      switch (run.phase) {
        case "claiming":
          return reconcileClaiming(deps, run, belt, src);
        case "running": {
          const step = stepByName(belt, run.step);
          if (step) return reconcileStep(deps, run, belt, src, step);
          // The active step isn't in this belt anymore (belt steps reordered/renamed mid-flight).
          return escalateAttention(deps, run, {
            reason: "unknown_step",
            attentionReason: `step "${run.step}" is not in belt "${belt.name}"`,
            body: `${run.ticketKey}: its active step "${run.step}" no longer exists in belt "${belt.name}".`,
            detail: { step: run.step, belt: belt.name },
          });
        }
        case "waiting_for_human":
          return reconcileWaitingForHuman(deps, run, belt, src);
        case "reviewing":
          return reconcileReviewing(deps, run, src, ctx);
        case "tearing_down":
          return teardown(deps, run, run.outcome ?? "abandoned", src);
        case "attention":
          return reconcileAttention(deps, run, belt, src, ctx);
        case "done":
          return;
      }
    },
  );
}

/**
 * Apply a deferred focus shift, if one is pending. The active step's pane is brought to the
 * front ONLY when the user is currently viewing this run's worktree AND sitting on one of its
 * belt panes — so we never steal focus from another worktree, and never yank the user off
 * an unrelated (editor/server/scratch) pane. If those conditions don't hold, the pending flag
 * is left set and re-checked on later ticks. herdr exposes no focus-change event, so we poll
 * the focused pane here — but only when there's actually something pending (the cheap path
 * for the common case is a single boolean read).
 */
export async function applyPendingFocus(deps: Deps, run: Run): Promise<void> {
  if (!run.focusPending) return;
  if (run.phase !== "running" || !run.step) {
    // No active belt step (claiming/reviewing/teardown/done) — nothing to focus; clear the flag.
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  const belt = deps.resolveBelt(run.belt);
  if (!belt) {
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  const focused = await deps.herdr.focusedPane();
  if (!focused) return; // herdr not frontmost / no focused pane — keep pending
  if (focused.workspaceId !== run.workspaceId) return; // user is in another worktree — keep pending

  // "one of this belt's step panes" = the panes we've dispatched steps to for this run. If the
  // user is parked on some other pane, hold the focus rather than pull them.
  const beltPanes = belt.steps.map((s) => deps.store.getRunStep(run.id, s.name)?.paneId).filter(Boolean);
  if (!beltPanes.includes(focused.paneId)) return; // on a non-belt pane — keep pending

  const target = deps.store.getRunStep(run.id, run.step)?.paneId;
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
    detail: { step: run.step, paneId: target },
  });
}

async function reconcileClaiming(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime): Promise<void> {
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

  // 2. materialize the work item (idempotent) and dispatch the belt's FIRST step. If the
  //    configured layout pane isn't up yet, stay in `claiming` and retry next tick (bounded;
  //    escalate to attention on timeout) — never spawn our own when a tab/pane is configured.
  const first = firstStep(belt);
  if (!deps.store.getRunStep(run.id, first.name)?.paneId) {
    await materializeWork(deps, run, src);
    const res = await spawnStep(deps, run, belt, src, first.name);
    if (res.status === "waiting") return handleLayoutWait(deps, run, belt, first);
    run = deps.store.getRun(run.id)!;
  }

  // 3. Advance to running FIRST, then request the in-development transition. Gating the phase on
  //    the transition would pin the run in `claiming` forever if the transition keeps failing
  //    (auth/workflow) while its first agent runs and finishes unobserved. The outbox owns the
  //    write-back from here: a failed attempt is retried each tick until the source confirms.
  deps.store.updateRun(run.id, { phase: "running", step: first.name });
  deps.log("info", `${run.ticketKey}: running ${first.name} on ${branch}`);
  await requestTransition(deps, run, src, "in_development");
}

/** Advance the active step's heartbeat when the branch HEAD moves; returns the fresh
 *  step row. A moving HEAD = real work, so it resets that step's stall clock. */
async function trackStepProgress(deps: Deps, run: Run, step: string): Promise<RunStep> {
  const s = deps.store.getRunStep(run.id, step)!;
  if (!run.worktreePath) return s;
  const sha = await deps.git.headSha(run.worktreePath);
  if (!sha || sha === s.progressSig) return s;
  return deps.store.upsertRunStep(run.id, step, { progressSig: sha, progressAt: deps.now() });
}

/** Park a run for human attention: flip phase, record the reason, fire a notification, and put
 *  the reason where the humans already look — the work source itself (Jira comment / local note). */
async function escalateAttention(
  deps: Deps,
  run: Run,
  opts: { reason: string; attentionReason: string; body: string; detail?: Record<string, unknown>; skipSourceNote?: boolean },
): Promise<void> {
  deps.store.updateRun(run.id, { phase: "attention", attentionReason: opts.attentionReason, attentionNotifiedAt: deps.now() });
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
  // Best-effort source write-back (once, on escalation — the periodic re-notify stays local).
  // Skipped when the escalation IS about the source item being gone — posting to it can't work.
  const src = opts.skipSourceNote ? undefined : deps.resolveSource(run.workSource);
  if (src) {
    await src.client
      .postNote(
        run.ticketKey,
        `⚠ herdr-factory parked this run for attention: ${opts.attentionReason}\n\n${opts.body}\n\nResume with: herdr-factory --repo ${deps.config.repoName} resume ${run.ticketKey}`,
      )
      .catch((e) => deps.log("warn", `${run.ticketKey}: attention note not posted to ${src.name}: ${err(e)}`));
  }
}

async function postHumanQuestion(deps: Deps, src: SourceRuntime, q: HumanQuestion): Promise<HumanQuestion> {
  if (q.externalId) return q;
  const res = await src.client.askHuman({
    repo: deps.config.repoName,
    runId: q.runId,
    questionId: q.id,
    key: q.ticketKey,
    step: q.step,
    question: q.question,
  });
  deps.store.updateHumanQuestion(q.id, { externalId: res.externalId, externalCreatedAt: res.externalCreatedAt ?? null });
  return deps.store.getHumanQuestion(q.id)!;
}

/** Agent-facing pause primitive: persist a human question, post it through the run's source, and
 *  park the run until `reconcileWaitingForHuman` sees a source-native reply. */
export async function requestHumanInput(
  deps: Deps,
  run: Run,
  step: string,
  question: string,
): Promise<{ ok: boolean; questionId: number; posted: boolean; message?: string }> {
  const src = deps.resolveSource(run.workSource);
  if (!src) throw new Error(`${run.ticketKey}: work source "${run.workSource}" not configured`);

  // Reuse a pending question only when it IS this question (same step + text) — the idempotent
  // re-ask path. A DIFFERENT pending question (possible after a resume out of a parked human
  // loop) must be superseded, not silently reused: binding the new ask to the old row would post
  // nothing to the source and anchor the reply poll on a comment no human is answering.
  const pending = deps.store.pendingHumanQuestionForRun(run.id);
  const existing = pending && pending.step === step && pending.question === question.trim() ? pending : undefined;
  if (pending && !existing) {
    deps.store.updateHumanQuestion(pending.id, {
      status: "answered",
      answer: "(superseded by a newer question from the agent — no human reply was received)",
      answeredAt: deps.now(),
    });
    deps.log("warn", `${run.ticketKey}: superseding stale pending question #${pending.id} with a new ask`);
  }
  let q = existing ?? deps.store.createHumanQuestion({
    runId: run.id,
    repo: deps.config.repoName,
    workSource: src.name,
    ticketKey: run.ticketKey,
    step,
    question: question.trim(),
  });

  deps.store.updateRun(run.id, { phase: "waiting_for_human", step, attentionReason: null });
  let posted = q.externalId !== null;
  let message: string | undefined;
  try {
    q = await postHumanQuestion(deps, src, q);
    posted = q.externalId !== null;
  } catch (e) {
    message = `question recorded; posting deferred: ${err(e)}`;
    deps.log("warn", `${run.ticketKey}: human question #${q.id} post deferred: ${err(e)}`);
  }

  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "human_question",
    detail: { step, questionId: q.id, externalId: q.externalId, posted, reused: existing !== undefined },
  });
  deps.log("info", `${run.ticketKey}: waiting for human answer to question #${q.id}`);
  return { ok: true, questionId: q.id, posted, message };
}

function writeHumanReply(run: Run, q: HumanQuestion, replyBody: string, author: string | null | undefined): string | null {
  if (!run.worktreePath) return null;
  const dir = join(run.worktreePath, MEMORY_DIR, "human-replies");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `question-${q.id}.md`);
  writeFileSync(
    file,
    [
      `# Human reply for ${run.ticketKey}`,
      "",
      `Question: #${q.id}`,
      `Step: ${q.step ?? "unknown"}`,
      author ? `Author: ${author}` : null,
      "",
      "## Question",
      "",
      q.question,
      "",
      "## Reply",
      "",
      replyBody,
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
  return file;
}

async function resumeAfterHumanReply(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, q: HumanQuestion, replyFile: string | null): Promise<void> {
  const step = q.step ?? run.step;
  if (!step || !stepByName(belt, step)) {
    await escalateAttention(deps, run, {
      reason: "human_reply_unknown_step",
      attentionReason: `human reply arrived for unknown step "${step ?? "(none)"}"`,
      body: `${run.ticketKey}: a human replied to question #${q.id}, but the original step no longer exists in belt "${belt.name}".`,
      detail: { questionId: q.id, step },
    });
    return;
  }

  deps.store.updateRun(run.id, { phase: "running", step, attentionReason: null, focusPending: true });
  const prompt =
    `Human guidance has arrived for ${run.ticketKey} question #${q.id}. ` +
    (replyFile ? `Read ${replyFile} in this worktree, ` : "Read the latest human reply in this worktree, ") +
    `continue the ${step} step, and only run step-done when the step is actually complete.`;

  if (run.paneId && (await deps.herdr.paneAlive(run.paneId))) {
    await deps.herdr.agentSend(run.paneId, prompt);
    await deps.herdr.paneSendKeys(run.paneId, "Enter");
    deps.log("info", `${run.ticketKey}: resumed ${step} with human reply #${q.id}`);
    return;
  }

  await spawnStep(deps, deps.store.getRun(run.id)!, belt, src, step);
  deps.log("info", `${run.ticketKey}: respawned ${step} after human reply #${q.id}`);
}

/** Persist a bounce's findings where the bounced-to step's agent will read them. Named by the
 *  TARGET step (feedback-<toStep>.md, overwritten on each bounce) so the target's prompt can surface
 *  it deterministically (see renderStepPromptImpl's rework banner). Returns the worktree-relative
 *  path (for the event + re-dispatch prompt), or null if the run has no worktree. */
function writeBounceNote(run: Run, fromStep: string, toStep: string, reason: string): string | null {
  if (!run.worktreePath) return null;
  const dir = join(run.worktreePath, MEMORY_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `feedback-${toStep}.md`),
    [
      `# Rework requested for ${run.ticketKey}`,
      "",
      `The **${fromStep}** step sent this work back to the **${toStep}** step. Address the findings`,
      `below, then finish the ${toStep} step as normal (the pipeline will run forward from here again).`,
      "",
      "## Findings to address",
      "",
      reason.trim(),
      "",
    ].join("\n"),
  );
  return `${MEMORY_DIR}/feedback-${toStep}.md`;
}

/**
 * Backward transition: the current (running) step sends the run BACK to an earlier step for rework.
 * The counterpart to reconcileStep's forward `nextStep` advance and the analog of the ask-human
 * park/resume — but re-pointed at an earlier step, with three things resumeAfterHumanReply does NOT
 * do (each load-bearing):
 *   1. CLEAR the target step's `done` (+ reset its heartbeat clocks) — else reconcileStep advances
 *      the just-bounced step instantly on the next tick (it re-reads rs.done, reconcileStep §done).
 *   2. Re-dispatch the TARGET step's own pane (getRunStep(toStep).paneId) — NOT run.paneId, which is
 *      the bouncer's (latest-dispatched) pane.
 *   3. Bump + cap a per-target bounce counter, escalating to attention past limits.maxBounces.
 * Guarded: only from a `running` step, only to an earlier step the current step declares in
 * `canBounceTo`. The bouncer does NOT step-done, so after the target re-completes the pipeline runs
 * forward and re-enters the (still-not-done) bouncer cleanly.
 */
export async function bounceStep(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  toStep: string,
  reason: string,
): Promise<{ ok: boolean; escalated?: boolean; message?: string }> {
  const fromStep = run.step;
  if (run.phase !== "running" || !fromStep) return { ok: false, message: "no running step to bounce from" };
  const from = stepByName(belt, fromStep);
  const to = stepByName(belt, toStep);
  if (!from || !to) return { ok: false, message: `step "${toStep}" is not in belt "${belt.name}"` };
  const idxTo = indexOfStep(belt, toStep);
  const idxFrom = indexOfStep(belt, fromStep);
  if (idxTo >= idxFrom) {
    return { ok: false, message: `${toStep} is not before ${fromStep} — bounces only go backward` };
  }
  if (!from.canBounceTo.includes(toStep)) {
    return { ok: false, message: `the ${fromStep} step may not bounce to ${toStep}` };
  }

  const repo = deps.config.repoName;
  // Safety backstop only: the loop is meant to end when the later step passes (aligned) or the fix
  // agent asks a human — this cap just catches oscillation. Per-belt override wins over the repo limit.
  const maxBounces = belt.maxBounces ?? deps.config.limits.maxBounces;
  const bounces = deps.store.bumpBounces(run.id, toStep);
  if (bounces > maxBounces) {
    await escalateAttention(deps, run, {
      reason: "bounce_limit",
      attentionReason: `bounced to ${toStep} ${bounces}× (max ${maxBounces})`,
      body: `${run.ticketKey}: the work has been bounced back to the ${toStep} step ${bounces} times (from ${fromStep}), exceeding max_bounces (${maxBounces}). A human should look — the agents may be stuck in a rework loop.`,
      detail: { fromStep, toStep, bounces },
    });
    return { ok: true, escalated: true, message: `bounce limit exceeded — escalated to attention` };
  }

  // (1) Clear done + reset heartbeat clocks for the TARGET *and every completed step between it and
  //     the bouncer* — those intermediate steps must actually re-run on the forward pass, not be
  //     skipped on their stale done=true (e.g. a review→fix bounce must force the evidence step to
  //     re-capture the reworked change, not re-PR the pre-fix evidence). The bouncer (idxFrom) didn't
  //     step-done, so it's excluded; its clocks reset when the forward pass respawns it.
  for (let i = idxTo; i < idxFrom; i++) {
    deps.store.upsertRunStep(run.id, belt.steps[i]!.name, { done: false, progressSig: null, progressAt: null });
  }
  const notePath = writeBounceNote(run, fromStep, toStep, reason);
  // (5) Rewind the active-step pointer.
  deps.store.updateRun(run.id, { phase: "running", step: toStep, attentionReason: null, focusPending: true });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "bounced", detail: { fromStep, toStep, bounces, notePath } });
  deps.log("info", `${run.ticketKey}: ${fromStep} bounced work back to ${toStep} (#${bounces})`);

  // (6) Re-dispatch the TARGET step. Prefer re-prompting its own live pane (keeps context); else
  //     respawn. Reusing a live pane also needs started_at reset (spawnStep does this on respawn).
  const target = deps.store.getRunStep(run.id, toStep);
  if (target?.paneId && (await deps.herdr.paneAlive(target.paneId))) {
    const prompt =
      `The ${fromStep} step sent this work back for rework (${run.ticketKey}). ` +
      (notePath ? `Read ${notePath} in this worktree, ` : "Read the latest feedback note in this worktree, ") +
      `address the findings, and only run step-done when the ${toStep} step is genuinely complete.`;
    await deps.herdr.agentSend(target.paneId, prompt);
    await deps.herdr.paneSendKeys(target.paneId, "Enter");
    deps.store.upsertRunStep(run.id, toStep, { startedAt: deps.now() });
    deps.store.updateRun(run.id, { paneId: target.paneId });
    deps.log("info", `${run.ticketKey}: re-prompted ${toStep} on live pane ${target.paneId}`);
    return { ok: true };
  }
  await spawnStep(deps, deps.store.getRun(run.id)!, belt, src, toStep);
  deps.log("info", `${run.ticketKey}: respawned ${toStep} for rework`);
  return { ok: true };
}

/**
 * The evidence agent signals it is starting a capture attempt. Bumps the running step's
 * capture-attempt counter and — once it exceeds `limits.maxCaptureAttempts` — parks the run for a
 * human (a flaky app that can't be captured cleanly should surface, not loop forever). This is the
 * ENGINE BACKSTOP behind the evidence prompt's cooperative "re-record a bad take, then ask-human"
 * guidance — the analog of the bounce cap, but the counter is reset on each fresh pass INTO the step
 * (reconcileStep's forward advance + resumeRun), so a legitimate re-capture after a fix rework gets a
 * full budget instead of inheriting the previous pass's count. Only valid for a `gathersEvidence`
 * step that is currently running.
 */
export async function recordCaptureAttempt(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  stepArg?: string,
): Promise<{ ok: boolean; attempts?: number; escalated?: boolean; message?: string }> {
  const step = run.step;
  if (run.phase !== "running" || !step) return { ok: false, message: "no running step to record a capture attempt for" };
  // The signal now names its step explicitly (a belt may have >1 evidence step); reject one
  // addressed to a step that isn't the one currently running (a stale/misaddressed capture-attempt).
  if (stepArg && stepArg !== step) return { ok: false, message: `capture-attempt names step "${stepArg}" but the running step is "${step}"` };
  const s = stepByName(belt, step);
  if (!s) return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
  if (!s.gathersEvidence) return { ok: false, message: `the ${step} step does not gather evidence` };

  const repo = deps.config.repoName;
  const cap = deps.config.limits.maxCaptureAttempts;
  const attempts = deps.store.bumpCaptureAttempts(run.id, step);
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "capture_attempt", detail: { step, attempts, cap } });
  if (attempts > cap) {
    await escalateAttention(deps, run, {
      reason: "capture_limit",
      attentionReason: `capture attempt ${attempts} over cap (${cap}) on ${step}`,
      body: `${run.ticketKey}: the ${step} step has begun ${attempts} capture attempts (cap ${cap}) without passing evidence forward. The app may be too flaky to capture cleanly, or the change isn't demonstrable — a human should look.`,
      detail: { step, attempts, cap },
    });
    return { ok: true, attempts, escalated: true, message: `capture attempt cap (${cap}) exceeded — parked for attention` };
  }
  deps.log("info", `${run.ticketKey}: ${step} capture attempt #${attempts}/${cap}`);
  return { ok: true, attempts };
}

/** Consecutive pollHumanReply THROWS before a waiting run escalates (misses never count — humans
 *  are allowed to be slow). At the 5-min backoff cap this is ~100 min of a failing source. */
const HUMAN_POLL_ERROR_ESCALATE = 20;

/** Attention reasons raised by a STEP's own execution watchdog — the evidence flaky-capture cap, the
 *  per-step budget, the commit-stall heartbeat, and the layout-pane wait. These are backstops against
 *  a stuck agent, NOT a veto on finished work: an agent that reaches step-done is by definition not
 *  looping, so a genuine step-done from the parked step un-parks the run and lets the pipeline advance
 *  (reconcileAttention). Every OTHER park — source item gone, PR closed, bounce oscillation, human
 *  loop, config error — needs a human decision and is never auto-rescued. */
// DERIVED (not a hardcoded literal) as the union of every registered step primitive's guards whose
// `autoRescueOnDone` is true. A plugin guard that parks a run participates automatically — no edit
// to a literal Set. read_only_violation / source_item_stale / pr_closed / bounce_limit / human /
// config parks are NOT guards, so they stay non-auto-rescued (a human decides).
const STEP_WATCHDOG_ATTENTION = new Set(
  STEP_DESCRIPTORS.flatMap((d) => d.guards)
    .filter((g) => g.autoRescueOnDone)
    .map((g) => g.escalationReason),
);

/** The item backing a pending human question is gone (deleted/transferred) — the reply can never
 *  arrive. Park for a human; no source note (the item it would go to is what's gone). */
function humanLoopStale(deps: Deps, run: Run, q: HumanQuestion, why: string): Promise<void> {
  return escalateAttention(deps, run, {
    reason: "source_item_stale",
    attentionReason: `work item gone while waiting for a human reply (${why})`,
    body: `${run.ticketKey}: question #${q.id} can never be answered — the work item is gone at the source (${why}). Tear the run down (resuming would just re-park after the next poll finds the item still gone).`,
    detail: { questionId: q.id, why },
    skipSourceNote: true,
  });
}

async function reconcileWaitingForHuman(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime): Promise<void> {
  let q = deps.store.pendingHumanQuestionForRun(run.id);
  if (!q) {
    if (run.step && stepByName(belt, run.step)) {
      deps.log("warn", `${run.ticketKey}: waiting_for_human without a pending question — resuming ${run.step}`);
      deps.store.updateRun(run.id, { phase: "running", attentionReason: null });
    } else {
      await escalateAttention(deps, run, {
        reason: "human_wait_missing_question",
        attentionReason: "waiting_for_human without a pending question",
        body: `${run.ticketKey}: run is waiting_for_human but no pending question exists in the database.`,
      });
    }
    return;
  }

  if (!q.externalId) {
    try {
      q = await postHumanQuestion(deps, src, q);
      deps.store.recordEvent({
        runId: run.id,
        repo: deps.config.repoName,
        ticketKey: run.ticketKey,
        type: "human_question",
        detail: { step: q.step, questionId: q.id, externalId: q.externalId, posted: true, retry: true },
      });
    } catch (e) {
      if (e instanceof StaleItemError) return humanLoopStale(deps, run, q, err(e));
      deps.log("warn", `${run.ticketKey}: human question #${q.id} still not posted: ${err(e)}`);
      return;
    }
  }
  const externalId = q.externalId;
  if (!externalId) return;

  // Poll backoff: humans answer in minutes-to-hours; per-tick polling of every waiting run was
  // sustained source-API load for nothing. Misses double the interval (60s → 5min cap).
  if (deps.now() < q.nextPollAt) return;

  let reply: HumanReply | null;
  try {
    reply = await src.client.pollHumanReply({
      key: run.ticketKey,
      questionId: q.id,
      externalId,
      externalCreatedAt: q.externalCreatedAt,
    });
  } catch (e) {
    // The item backing the question is gone → escalate now. Anything else is a poll ERROR:
    // backoff like a miss (a rate-limited source must not make the Phase A error path hot every
    // tick) but count it separately — a slow HUMAN is normal, a persistently-throwing source is
    // not, and a parked run doesn't occupy capacity so it would otherwise wedge invisibly.
    if (e instanceof StaleItemError) return humanLoopStale(deps, run, q, err(e));
    if (isSourceUnauthenticated(e)) {
      // Auth-held, NOT a poll failure: record + notify (once), back off like a normal miss, and
      // NEVER count toward the poll-error escalation. A human is still expected to answer — the
      // source just needs re-auth — so parking the run for attention would be wrong.
      await noteSourceAuthFailure(deps, src.name, e);
      const held = deps.store.recordHumanPollMiss(q.id);
      deps.log("warn", `${run.ticketKey}: reply poll for #${q.id} held — ${src.name} not authenticated (next poll in ${held.nextPollAt - deps.now()}s)`);
      return;
    }
    const errored = deps.store.recordHumanPollError(q.id);
    deps.log("warn", `${run.ticketKey}: reply poll for question #${q.id} failed (${errored.pollErrors} consecutive): ${err(e)}`);
    if (errored.pollErrors >= HUMAN_POLL_ERROR_ESCALATE) {
      await escalateAttention(deps, run, {
        reason: "human_poll_failing",
        attentionReason: `reply polling has failed ${errored.pollErrors} times in a row`,
        body: `${run.ticketKey}: polling for a reply to question #${q.id} keeps failing (${err(e)}). The question may need re-posting, or the source is unhealthy — run doctor.`,
        detail: { questionId: q.id, pollErrors: errored.pollErrors },
      });
    }
    return;
  }
  noteSourceAuthRecovered(deps, src.name); // the poll call itself succeeded ⇒ auth is fine
  if (!reply) {
    const missed = deps.store.recordHumanPollMiss(q.id);
    deps.log("info", `${run.ticketKey}: waiting for human reply to question #${q.id} (next poll in ${missed.nextPollAt - deps.now()}s)`);
    return;
  }

  const answered = deps.store.answerHumanQuestion(q.id, reply);
  const replyFile = writeHumanReply(run, q, reply.body, reply.author);
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "human_reply",
    detail: { questionId: q.id, externalId: reply.externalId, author: reply.author ?? null, replyFile },
  });
  await resumeAfterHumanReply(deps, run, belt, src, answered, replyFile);
}

/** A step is waiting for its configured layout pane to come up (an idle agent in tab/pane).
 *  Stay put and retry next tick, but escalate to attention once we've waited past
 *  `layout_wait_seconds` (measured from the step row's started_at). Only steps that HAVE a
 *  tab/pane ever wait — steps without one spawn their own pane and never reach here. */
async function handleLayoutWait(deps: Deps, run: Run, belt: BeltRuntime, step: StepConfig): Promise<void> {
  const where = `${step.tab}/${step.pane}`;
  const since = deps.store.getRunStep(run.id, step.name)?.startedAt ?? deps.now();
  const waited = deps.now() - since;
  if (waited <= deps.config.limits.layoutWaitSeconds) {
    deps.log("info", `${run.ticketKey}: ${step.name} waiting for layout pane ${where} (${waited}s/${deps.config.limits.layoutWaitSeconds}s)`);
    return;
  }
  await escalateAttention(deps, run, {
    reason: "layout_wait_timeout",
    attentionReason: `${step.name}: layout pane ${where} never became available`,
    body: `${step.name} step (belt ${belt.name}): configured pane ${where} didn't come up with an idle agent within ${Math.round(deps.config.limits.layoutWaitSeconds / 60)}min — is the herdr layout for this worktree running?`,
    detail: { step: step.name, tab: step.tab, pane: step.pane },
  });
}

/**
 * Resolve the run's PR. Once a number has been adopted we poll BY NUMBER — that's the PR's durable
 * identity and it keeps resolving after the head branch is deleted (GitHub auto-delete-on-merge).
 * Only the first sighting, before any number is recorded, falls back to branch discovery.
 */
async function currentPr(deps: Deps, run: Run): Promise<PrInfo | null> {
  if (run.prNumber) return deps.github.prByNumber(deps.ghRepo, run.prNumber);
  return run.branch ? deps.github.prForBranch(deps.ghRepo, run.branch) : null;
}

/** A PR we own was closed without merging — hand it to a human rather than tearing down silently. */
function prClosedAttention(deps: Deps, run: Run, pr: PrInfo): Promise<void> {
  return escalateAttention(deps, run, {
    reason: "pr_closed",
    attentionReason: `PR #${pr.number} closed without merging`,
    body: `${run.ticketKey}: PR #${pr.number} was closed without being merged (${pr.url}). Reopen it and let the run continue, or tear the run down.`,
    detail: { number: pr.number, url: pr.url },
  });
}

/**
 * Generic per-step gate. Ensures the step's agent is alive, advances on `step-done` (or a merged
 * PR for a PR-opening step), else runs the watchdog: a commit-HEAD stall heartbeat (when the step
 * declares one), a per-step budget, and liveness — escalating to `attention` only when the agent
 * isn't actively working. Re-spawns a dead pane idempotently. When the belt's last step finishes:
 * a work_to_pull_request belt hands off to the reviewing PR-watch; any other belt is done.
 */
async function reconcileStep(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, step: StepConfig): Promise<void> {
  const rs = deps.store.getRunStep(run.id, step.name);

  // (Re)spawn if there's no live pane recorded for this step (first entry / crash gap). If
  // the step's configured layout pane isn't up yet, wait (bounded → attention) rather than
  // spawning our own.
  if (!rs || !rs.paneId) {
    const res = await spawnStep(deps, run, belt, src, step.name);
    if (res.status === "waiting") await handleLayoutWait(deps, run, belt, step);
    return;
  }

  // Only a PR-opening step (work_to_pull_request's `pr`) watches GitHub. Adopt a live (open/merged)
  // PR's number on first sighting; thereafter currentPr polls by that number. Act on a CLOSED PR
  // only when it is *ours* (an adopted number) — a stale CLOSED PR discovered by a reused branch
  // name must not disturb a fresh attempt.
  const pr = step.opensPr ? await currentPr(deps, run) : null;
  if (pr && pr.state !== "CLOSED" && run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });
  if (pr && pr.state === "CLOSED" && pr.number === run.prNumber) return prClosedAttention(deps, run, pr);
  const livePr = pr && pr.state !== "CLOSED" ? pr : null;

  // read_only enforcement: a read-only step (review/evidence) must never edit or commit. The
  // baseline HEAD was captured at spawn (progressSig); a moved HEAD means it committed — a contract
  // violation. Park for a human (NOT auto-rescuable) rather than advancing a step that misbehaved.
  if (step.readOnly && rs.progressSig && run.worktreePath) {
    const head = await deps.git.headSha(run.worktreePath).catch(() => null);
    if (head && head !== rs.progressSig) {
      return escalateAttention(deps, run, {
        reason: "read_only_violation",
        attentionReason: `${step.name} is read-only but committed (HEAD moved)`,
        body: `${run.ticketKey}: the ${step.name} step is read-only — it must never edit or commit — but the branch HEAD moved from ${rs.progressSig.slice(0, 8)} to ${head.slice(0, 8)}. A human should review; the agent violated the read-only contract.`,
        detail: { step: step.name, baseline: rs.progressSig, head },
      });
    }
  }

  // Advance when the agent signalled step-done (or its PR merged out from under us).
  if (rs.done || livePr?.state === "MERGED") {
    const next = nextStep(belt, step.name);
    if (next) {
      deps.store.updateRun(run.id, { phase: "running", step: next.name });
      // Fresh pass into an evidence step ⇒ reset its flaky-capture budget (this is the ONLY reset on
      // the forward path; a crash-recovery respawn below deliberately does NOT reset, so a self-crash
      // can't refill the cap). Cheap + scoped: only a gathersEvidence step ever holds a nonzero count.
      if (next.gathersEvidence) deps.store.upsertRunStep(run.id, next.name, { captureAttempts: 0 });
      deps.log("info", `${run.ticketKey}: ${step.name} done -> ${next.name}`);
      await spawnStep(deps, run, belt, src, next.name);
      return;
    }
    // Last step of the belt.
    if (belt.watchPr) {
      // Hand off to the human-review watch, but only with a real PR. If the agent signalled done
      // before a PR is visible (push lag / never opened), fall through to the watchdog rather than
      // wedging in `reviewing` with no PR to watch.
      if (livePr) return enterReviewing(deps, run, src, livePr.number);
    } else {
      // A non-PR belt is complete the moment its last step signals done.
      deps.log("info", `${run.ticketKey}: ${step.name} done — belt ${belt.name} complete`);
      return teardown(deps, run, "completed", src);
    }
  }

  // Not done — watchdog. Commit-HEAD heartbeat (steps that make commits), per-step budget, liveness.
  const active = step.heartbeat ? await trackStepProgress(deps, run, step.name) : rs;
  const stalled =
    step.heartbeat &&
    active.progressSig != null &&
    active.progressAt != null &&
    deps.now() - active.progressAt > deps.config.limits.stallSeconds;
  const overBudget = active.startedAt != null && deps.now() - active.startedAt > step.budgetSeconds;

  if (stalled || overBudget) {
    let ws: string;
    try {
      ws = active.paneId ? await deps.herdr.paneState(active.paneId) : "gone";
    } catch (e) {
      if (e instanceof HerdrUnreachableError) {
        // Can't judge the worker while herdr is unreachable — a false "gone" here would park a
        // healthy run in attention. Defer the whole watchdog to a later tick.
        deps.log("warn", `${run.ticketKey}: ${step.name} watchdog deferred — ${e.message}`);
        return;
      }
      throw e;
    }
    // A worker that is still actively working is not stuck — extend regardless of budget OR stall.
    // (Long-horizon policy: a LIVE agent is never parked by a timer; only a genuinely idle or dead
    // one is. This is deliberately more permissive than the old budget-only extension — an agent
    // doing a long stretch between commits, e.g. a big refactor or a slow build/test cycle, keeps
    // going instead of being parked at the stall window. The trade: a working-but-wedged agent that
    // never commits is no longer caught by the stall timer — the dead-pane/liveness recovery below
    // and the operator remain its backstops.)
    if (ws === "working") {
      deps.log("info", `${run.ticketKey}: ${step.name} past ${stalled ? "stall window" : "budget"} but still working — extending`);
      return;
    }
    await escalateAttention(deps, run, {
      reason: stalled ? "step_stalled" : "step_budget",
      attentionReason: `${step.name} step ${stalled ? "stalled" : "over budget"} (worker: ${ws})`,
      body: stalled
        ? `${step.name} step stalled ${Math.round(deps.config.limits.stallSeconds / 60)}min — no new commits (worker: ${ws}).`
        : `${step.name} step over ${Math.round(step.budgetSeconds / 60)}min budget (worker: ${ws}).`,
      detail: { step: step.name, worker: ws },
    });
    return;
  }

  // Agent pane died before signalling → re-spawn (idempotent recovery). Guarded three ways,
  // because the respawn of a NOT-actually-dead pane puts a duplicate agent into the worktree:
  //  1. herdr unreachable ≠ pane dead — HerdrUnreachableError defers the check to a later tick.
  //  2. A memoized "absent" is re-checked with a FRESH `herdr agent list` before it counts.
  //  3. Two-strike confirmation: the first confirmed absence only records `absentAt`; only a
  //     second confirmed absence past the confirmation window respawns (a herdr-daemon restart
  //     that briefly drops every pane from the list heals in between).
  let alive: boolean;
  try {
    alive = await deps.herdr.paneAlive(rs.paneId);
    if (!alive) alive = await deps.herdr.paneAlive(rs.paneId, { fresh: true });
  } catch (e) {
    if (e instanceof HerdrUnreachableError) {
      deps.log("warn", `${run.ticketKey}: ${step.name} liveness check deferred — ${e.message}`);
      return;
    }
    throw e;
  }
  if (!alive) {
    // Re-check `done` first: it may have flipped (step-done) after our earlier read, in which
    // case the agent finished and exited — don't relaunch a completed step into a duplicate agent.
    const freshRow = deps.store.getRunStep(run.id, step.name);
    if (freshRow?.done) return; // finished; the next tick advances
    if (freshRow?.absentAt == null) {
      deps.store.upsertRunStep(run.id, step.name, { absentAt: deps.now() });
      deps.log("info", `${run.ticketKey}: ${step.name} pane ${rs.paneId} not listed — confirming before re-spawn`);
      return;
    }
    if (deps.now() - freshRow.absentAt < PANE_ABSENCE_CONFIRM_SECONDS) return; // within the window — wait
    deps.log("info", `${run.ticketKey}: ${step.name} pane gone (confirmed twice) — re-spawning`);
    await spawnStep(deps, run, belt, src, step.name);
    return;
  }
  if (rs.absentAt != null) deps.store.upsertRunStep(run.id, step.name, { absentAt: null }); // seen alive again
  deps.log("info", `${run.ticketKey}: awaiting step-done ${step.name} (pane ${rs.paneId})`);
}

/** Transition the work item to its review state and move the run into the human-review watch.
 *  work_to_pull_request belts only — reached after the PR step opens a PR. */
async function enterReviewing(deps: Deps, run: Run, src: SourceRuntime, prNumber: number): Promise<void> {
  const repo = deps.config.repoName;
  await requestTransition(deps, run, src, "in_review");
  // Clear the active step: in `reviewing` there's no belt step running (the engine watches the PR
  // by number). Record prNumber here too so the watch is self-sufficient even if step-adoption was
  // skipped. The watch starts idle (resolverActive=false) — it holds no slot until an actionable
  // review state wakes the resolver. There is no time limit; the watch rides until the PR resolves.
  deps.store.updateRun(run.id, { phase: "reviewing", step: null, prNumber, resolverActive: false });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "pr_opened", detail: { number: prNumber } });
  deps.log("info", `${run.ticketKey}: PR #${prNumber} -> reviewing`);
}

async function reconcileReviewing(deps: Deps, run: Run, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  const repo = deps.config.repoName;
  // Prefer the tick's batched snapshot (state + signature in one shared GraphQL request);
  // fall back to per-run polling for nudge callers or when the batch fetch failed.
  const snap = run.prNumber != null ? ctx.prSnapshots?.get(run.prNumber) : undefined;
  const pr = snap ?? (await currentPr(deps, run));
  if (!pr) return;
  if (run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });

  if (pr.state === "MERGED") return teardown(deps, run, "merged", src);
  if (pr.state === "CLOSED") return prClosedAttention(deps, run, pr);

  // The watch has NO time limit (there is no watch_hours) — it rides until the PR merges or closes.
  const sig = snap?.sig ?? (await deps.github.reviewSignature(deps.ghRepo, pr.number));
  const actionable = sig.unresolved > 0 || sig.failing > 0;
  // A review state we haven't handled yet — the trigger to (re)wake the resolver.
  const fresh = actionable && sig.sig !== run.lastThreadSig;

  // Dynamic occupancy: a reviewing run holds a max_active_workspaces slot ONLY while its resolver
  // is actively working. We need the resolver's live pane state only when there's fresh work to
  // hand it, OR when we currently believe it's active (to notice it going idle and release the
  // slot). Pure idle-watching — nothing fresh, resolver already idle — skips the pane call entirely
  // and holds no slot, so a PR can sit in review indefinitely without starving new claims.
  if (!fresh && !run.resolverActive) return;

  let wstate: string;
  try {
    wstate = run.paneId ? await deps.herdr.paneState(run.paneId) : "gone";
  } catch (e) {
    if (e instanceof HerdrUnreachableError) return; // can't tell if the resolver is mid-fix — retry next tick
    throw e;
  }
  const working = wstate === "working";

  if (!fresh) {
    // Reached only when we believed the resolver was active (guard above): once it goes idle, drop
    // the flag so the watch stops holding a slot. The PR keeps being watched — just for free.
    if (!working) {
      deps.store.updateRun(run.id, { resolverActive: false });
      deps.log("info", `${run.ticketKey}: resolver idle — PR #${pr.number} watch no longer holds a slot`);
    }
    return;
  }

  // Fresh review state to address.
  if (working) {
    // Resolver already mid-fix — it holds a slot; don't pile on. Ensure the flag reflects that.
    if (!run.resolverActive) deps.store.updateRun(run.id, { resolverActive: true });
    return;
  }

  // Only record the signature as handled (and claim a slot) if the resolver actually launched —
  // otherwise a failed spawn would mark it done and never retry, silently dropping the review round.
  const woke = await wakeResolver(deps, run, pr.number);
  if (!woke) {
    deps.log("warn", `${run.ticketKey}: resolver spawn failed; retrying next tick`);
    return;
  }
  deps.store.updateRun(run.id, { lastThreadSig: sig.sig, resolverActive: true });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "resolver_woken", detail: { unresolved: sig.unresolved, failing: sig.failing } });
}

/**
 * Attention isn't necessarily a dead end. For a work_to_pull_request belt whose run has already
 * opened a PR (prNumber set), keep polling that PR by number even while parked here: a merge that
 * lands while a human is looking — or after an escalation unrelated to the PR (watch timeout, step
 * budget) — should still tear the run down and reclaim its slot. A still-open/closed PR leaves the
 * attention state untouched (the human is handling it); non-PR belts and pre-PR runs stay put.
 * While parked, the operator is re-notified periodically — the one-shot escalation notify is easy
 * to miss, and a parked run must never go silently stale.
 */
async function reconcileAttention(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  // A step-execution watchdog (evidence flaky-capture cap, per-step budget/stall, layout wait) parked
  // this run — but its agent went on to genuinely FINISH the step and signal step-done, which set
  // rs.done while the run sat here. Since that watchdog is a backstop against a stuck agent, not a
  // veto on completed work, honor the step-done: un-park and delegate to reconcileStep, which sees
  // rs.done and advances forward normally (the evidence step → review, etc.). This is what keeps a
  // non-gating step (evidence) from wedging the pipeline when a flaky app needed more than the capped
  // number of takes. Fires on the step-done nudge AND on any later tick, so a nudge dropped on run-lock
  // contention still heals here. Guarded to a still-active belt step that reports done, and only for
  // the watchdog reasons — a source-stale / pr-closed / bounce / human / config park is left for a human.
  if (run.step) {
    const step = stepByName(belt, run.step);
    const rs = deps.store.getRunStep(run.id, run.step);
    if (step && rs?.done && STEP_WATCHDOG_ATTENTION.has(deps.store.lastAttentionReasonCode(run.id) ?? "")) {
      deps.store.updateRun(run.id, { phase: "running", attentionReason: null });
      deps.store.recordEvent({
        runId: run.id,
        repo: deps.config.repoName,
        ticketKey: run.ticketKey,
        type: "resumed",
        detail: { reason: "step_done_after_watchdog_park", step: run.step },
      });
      // Restore the pane label the escalation overwrote with "⚠ ATTENTION …" (best-effort).
      if (run.paneId) await deps.herdr.agentRename(run.paneId, `${run.step}:${run.ticketKey}`).catch(() => {});
      deps.log("info", `${run.ticketKey}: ${run.step} finished after a watchdog park — un-parking and advancing`);
      return reconcileStep(deps, deps.store.getRun(run.id)!, belt, src, step);
    }
  }
  if (belt.watchPr && run.prNumber) {
    const pr = ctx.prSnapshots?.get(run.prNumber) ?? (await currentPr(deps, run));
    if (pr?.state === "MERGED") return teardown(deps, run, "merged", src);
  }
  if (deps.now() - (run.attentionNotifiedAt ?? 0) >= deps.config.limits.attentionRenotifySeconds) {
    deps.store.updateRun(run.id, { attentionNotifiedAt: deps.now() });
    const parkedFor = Math.round((deps.now() - run.updatedAt) / 60);
    await deps.herdr
      .notify(
        `herdr-factory: ${run.ticketKey} still needs attention`,
        `${run.attentionReason ?? "parked"} — resume with \`herdr-factory --repo ${deps.config.repoName} resume ${run.ticketKey}\` or tear it down. (parked ~${parkedFor}min)`,
      )
      .catch(() => {});
  }
}

/**
 * Operator entry point: un-park a run from `attention` and put it back where it was. Most
 * attention reasons are transient (layout pane came up late, a budget expired on a slow-but-fine
 * step, a herdr blip) — before this existed the only way out was teardown, which threw the
 * worktree and all completed work away.
 *
 * The return target is derived from what the run had already reached:
 *   - an active step (`run.step` still in the belt) → `running` with that step's clocks reset
 *     (fresh budget/heartbeat/absence — the stale ones are usually why it parked);
 *   - a PR being watched (`prNumber` on a watchPr belt) → `reviewing`, idle, with a cleared thread
 *     signature (so the next actionable review state re-wakes the resolver);
 *   - neither → back to `claiming` (materialize + first dispatch are idempotent).
 * The caller reconciles right after, so the re-dispatch happens on this same pass.
 */
export async function resumeRun(deps: Deps, run: Run): Promise<{ ok: boolean; phase?: string; message?: string }> {
  if (run.phase !== "attention") {
    return { ok: false, message: `run is ${run.phase}, not attention — nothing to resume` };
  }
  const belt = deps.resolveBelt(run.belt);
  if (!belt) return { ok: false, message: `belt "${run.belt}" is not configured — re-add it or tear the run down` };

  const repo = deps.config.repoName;
  const pendingQuestion = deps.store.pendingHumanQuestionForRun(run.id);
  let phase: Run["phase"];
  if (pendingQuestion && run.step && stepByName(belt, run.step)) {
    // The run was parked OUT of waiting_for_human (poll failures / a stale item) with its
    // question still pending. Resuming to `running` would orphan it — the reply poller only
    // runs for waiting_for_human — silently dropping whatever the human answered. Go back to
    // waiting with a fresh poll window instead.
    deps.store.resetHumanPollBackoff(pendingQuestion.id);
    phase = "waiting_for_human";
  } else if (run.step && stepByName(belt, run.step)) {
    // Fresh slate on human resume: reset the step budget clocks AND the flaky-capture counter — a
    // human just intervened, so a capture-cap park must not immediately re-park on the next attempt.
    deps.store.upsertRunStep(run.id, run.step, { startedAt: deps.now(), progressSig: null, progressAt: null, absentAt: null, captureAttempts: 0 });
    phase = "running";
  } else if (belt.watchPr && run.prNumber) {
    // Back to watching the PR: clear the handled-signature so the next actionable review state
    // re-wakes the resolver, and start idle (holds no slot until it's actually resolving again).
    deps.store.updateRun(run.id, { lastThreadSig: null, resolverActive: false });
    phase = "reviewing";
  } else {
    phase = "claiming";
  }
  deps.store.updateRun(run.id, { phase, attentionReason: null, focusPending: true });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "resumed", detail: { phase, step: run.step } });
  // Undo the ⚠ pane label (best-effort; a re-spawn would rename it anyway).
  if (run.paneId) await deps.herdr.agentRename(run.paneId, `${run.step ?? "watch"}:${run.ticketKey}`).catch(() => {});
  deps.log("info", `${run.ticketKey}: resumed from attention -> ${phase}${run.step ? ` (${run.step})` : ""}`);
  return { ok: true, phase };
}

/**
 * herdr owns workspace+dir+registration; we delete only the local branch. Robust to a
 * partial `worktree remove`: herdr can deregister the git worktree but then error before
 * closing the workspace (and exits 0 with an error body), leaking the workspace + dir.
 * So: remove → verify the workspace is gone, else close it directly → clear the checkout
 * dir → prune the stale git registration → delete the branch (now safely not "checked out").
 */
async function teardown(deps: Deps, run: Run, outcome: Outcome, src: SourceRuntime | undefined): Promise<void> {
  return telemetrySpan(
    "reconcile.teardown",
    {
      repo: deps.config.repoName,
      "run.id": run.id,
      "work.key": run.ticketKey,
      "work.source": src?.name,
      belt: run.belt ?? undefined,
      outcome,
    },
    () => teardownImpl(deps, run, outcome, src),
  );
}

async function teardownImpl(deps: Deps, run: Run, outcome: Outcome, src: SourceRuntime | undefined): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.updateRun(run.id, { phase: "tearing_down", outcome });

  // Write the terminal lifecycle state back to the source (never blocks cleanup — the outbox
  // keeps retrying after the run ends). No-op for Jira (merged/aborted/done are unmapped → no
  // network); records merged/aborted/done for local_markdown so the file is never re-listed.
  // Skipped entirely if the source is gone.
  if (src) {
    await requestTransition(deps, run, src, outcomeToWorkState(outcome));
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

  // Best-effort drop of any still-pending evidence upload: the worktree (and its evidence dir) is gone,
  // so the bytes can't be uploaded anymore. Log the loss so it's visible rather than silent.
  const dropped = deps.store.abandonEvidenceUploadsForRun(run.id, `run torn down (${outcome}) before upload landed`);
  if (dropped > 0) deps.log("warn", `${run.ticketKey}: ${dropped} evidence upload(s) dropped at teardown — bytes never reached S3 (likely SSO was down through merge)`);

  deps.store.endRun(run.id, outcome);
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "torn_down", detail: { outcome } });
  deps.log("info", `${run.ticketKey}: torn down (${outcome})`);
}

// --- manual entry points (used by the CLI) ----------------------------------

/** Manually claim + start a single item on a named belt (the `claim` command). */
export async function claimTicket(deps: Deps, beltName: string, ticketKey: string): Promise<void> {
  const belt = deps.resolveBelt(beltName);
  if (!belt) {
    throw new Error(`unknown belt "${beltName}" — configured: ${deps.belts.map((b) => b.name).join(", ") || "(none)"}`);
  }
  const src = deps.resolveSource(belt.source);
  if (!src) throw new Error(`belt "${beltName}" references unconfigured work source "${belt.source}"`);
  if (deps.store.activeRunForTicket(deps.config.repoName, src.name, ticketKey)) {
    deps.log("warn", `${ticketKey}: already has an active run in source "${src.name}"`);
    return;
  }
  const ticket = await src.client.describe(ticketKey);
  // INV-11: describe may normalize an alternate identifier to the canonical key (e.g. a display
  // id → immutable id). Re-check dedup against the key that will actually be claimed, or the same
  // item could be claimed twice under two spellings.
  if (ticket.key !== ticketKey && deps.store.activeRunForTicket(deps.config.repoName, src.name, ticket.key)) {
    deps.log("warn", `${ticketKey}: already has an active run in source "${src.name}" (as ${ticket.key})`);
    return;
  }
  await claim(deps, belt, src, ticket);
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
