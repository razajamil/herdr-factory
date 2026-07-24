// The WATCH HARNESS: the observe lane's shared engine. A watch is a per-tick predicate over a
// running step's LIVE state (clocks, HEAD, pane state), evaluated under the run lock. The harness
// owns everything AROUND the predicate — evaluation order, the declared working-pane veto, the
// defer-ends-pass rule (unreachable herdr never judges), and message assembly — while each watch's
// policy (the twenty lines that know ITS failure mode: mobile baselines, re-based clocks, stall
// windows) stays a plain evaluate() function. This is the observe-lane dual of the intent ledger:
// the ledger unified ROWS for obligations-to-act; this unifies the HARNESS for
// conditions-to-enforce, because the predicates are exactly where the shipped bugs lived
// (RWR-18147's re-base rules, RWR-18204's tracks-until-working baseline) and must stay code.
//
// The DECLARATION half lives on GuardSpec (steps/guards.ts): `stage` places the watch before or
// after the done-advance, `vetoWhenWorking` opts into the harness's live-agent veto,
// `escalationReason`/rescue routing/`resetOn` were already declaration-driven. Evaluators are
// looked up by guard KIND in WATCH_EVALUATORS below — a guard kind with no evaluator (layout_wait:
// spawn-phase, driven by handleLayoutWait; capture_cap: signal-driven; exclusive_resource: not a
// watchdog) is simply not walked here.
//
// CONTRACT for an evaluate(): run-locked, read live state + its own watch columns, MAY update its
// own state (the heartbeat's progress tracking, the read-only baseline's track-until-frozen) —
// NEVER run.phase (a trip verdict is how a watch parks; the CALLER applies it, so watches stay
// import-free of the escalation machinery). `@@WORKER@@` in a trip's strings is substituted by the
// harness with the pane state it resolved for the veto.
import type { Deps } from "./deps.ts";
import { HerdrUnreachableError } from "./deps.ts";
import type { StepConfig } from "../config.ts";
import type { Run, RunStep, WatchRebaseTrigger } from "../types.ts";

/**
 * A watch's effective clock: its `watch_state` row (v34), else — for a row a draining old-code
 * process touched, which has no watch row — the frozen legacy run_steps columns. A PRESENT row
 * wins unconditionally: re-bases write nulls rather than deleting, so the fallback can never
 * resurrect a deliberately-cleared clock. Exported for the obligations facts.
 */
export function effectiveWatchClock(deps: Deps, rs: RunStep, kind: string): { sig: string | null; basedAt: number | null } {
  const ws = deps.store.getWatchState(rs.runId, rs.step, kind);
  if (ws) return { sig: ws.sig, basedAt: ws.basedAt };
  switch (kind) {
    case "budget":
      return { sig: null, basedAt: rs.startedAt };
    case "heartbeat":
      return { sig: rs.progressSig, basedAt: rs.progressAt };
    case "read_only":
      return { sig: rs.baselineSig, basedAt: rs.baselineFrozenAt };
    default:
      return { sig: null, basedAt: null };
  }
}

export interface WatchCtx {
  deps: Deps;
  run: Run;
  step: StepConfig;
  rs: RunStep;
}

export type WatchVerdict =
  /** Nothing wrong (the evaluator may still have updated its own state). */
  | { kind: "ok" }
  /** Can't judge this pass (its external input is unreadable) — END watch evaluation. */
  | { kind: "defer"; why: string }
  /** The watched condition failed. `trippedWhat` names the window for the veto's extend log;
   *  `@@WORKER@@` in the strings is filled by the harness after the veto resolves. */
  | { kind: "trip"; trippedWhat: string; attentionReason: string; body: string; detail?: Record<string, unknown> };

export type WatchEvaluator = (ctx: WatchCtx) => Promise<WatchVerdict>;

/** What the caller (reconcileStep) does with a pass's evaluation. */
export type WatchOutcome =
  | { action: "none" }
  | { action: "defer" } // stop this pass's step reconcile (retry next tick)
  | { action: "extend"; note: string } // tripped, but the declared veto found a live working agent
  | { action: "park"; reason: string; attentionReason: string; body: string; detail?: Record<string, unknown> };

// --- the shipped evaluators ---------------------------------------------------

/** budget: the per-step wall clock (its base re-bases at every (re-)entry, dispatch and resume —
 *  RWR-18147). */
const budgetEvaluate: WatchEvaluator = async ({ deps, step, rs }) => {
  const { basedAt } = effectiveWatchClock(deps, rs, "budget");
  if (basedAt == null || deps.now() - basedAt <= step.budgetSeconds) return { kind: "ok" };
  return {
    kind: "trip",
    trippedWhat: "budget",
    attentionReason: `${step.name} step over budget (worker: @@WORKER@@)`,
    body: `${step.name} step over ${Math.round(step.budgetSeconds / 60)}min budget (worker: @@WORKER@@).`,
    detail: { step: step.name },
  };
};

/** heartbeat: the commit-stall watch. OWNS its progress tracking — a moving branch HEAD is real
 *  work and resets the stall clock; only then is the window judged. */
const heartbeatEvaluate: WatchEvaluator = async ({ deps, run, step, rs }) => {
  let clock = effectiveWatchClock(deps, rs, "heartbeat");
  if (run.worktreePath) {
    const sha = await deps.git.headSha(run.worktreePath);
    if (sha && sha !== clock.sig) {
      deps.store.upsertWatchState(run.id, step.name, "heartbeat", { sig: sha, basedAt: deps.now() });
      clock = { sig: sha, basedAt: deps.now() };
    }
  }
  const stalled = clock.sig != null && clock.basedAt != null && deps.now() - clock.basedAt > deps.config.limits.stallSeconds;
  if (!stalled) return { kind: "ok" };
  return {
    kind: "trip",
    trippedWhat: "stall window",
    attentionReason: `${step.name} step stalled (worker: @@WORKER@@)`,
    body: `${step.name} step stalled ${Math.round(deps.config.limits.stallSeconds / 60)}min — no new commits (worker: @@WORKER@@).`,
    detail: { step: step.name },
  };
};

/** read_only: a read-only step (review/evidence, or a custom read_only gate) must never edit or
 *  commit. The baseline TRACKS live HEAD until this step's own agent is first observed `working` —
 *  absorbing the PRIOR step's trailing handoff-window commits (RWR-18204: the work agent committed
 *  a lint fix 101s after evidence spawned, wedging the run in a read_only park for a commit
 *  evidence never made) — then freezes; any further HEAD move is the real violation. Even the
 *  frozen violation is a BACKSTOP, not a veto: a genuine step-done un-parks and advances
 *  (STEP_WATCHDOG_ATTENTION), which is why this watch runs PRE-advance — a completed-but-violating
 *  step must park with its trail, and heal through the rescue, not slip through silently. */
const readOnlyEvaluate: WatchEvaluator = async ({ deps, run, step, rs }) => {
  const baseline = effectiveWatchClock(deps, rs, "read_only"); // sig = the baseline; basedAt = the freeze marker
  if (!step.readOnly || !baseline.sig || !run.worktreePath) return { kind: "ok" };
  const head = await deps.git.headSha(run.worktreePath).catch(() => null);
  if (!head) return { kind: "ok" };
  if (baseline.basedAt == null) {
    // Not yet frozen. Freeze at the current HEAD the first pass this step's agent is `working`;
    // until then keep the baseline synced to HEAD so the prior step's trailing commits absorb.
    // Herdr flaky here defers only the FREEZE (treat as not-working), never the whole pass.
    let working = false;
    try {
      working = rs.paneId != null && (await deps.herdr.paneState(rs.paneId)) === "working";
    } catch (e) {
      if (!(e instanceof HerdrUnreachableError)) throw e;
    }
    if (working) deps.store.upsertWatchState(run.id, step.name, "read_only", { sig: head, basedAt: deps.now() });
    else if (head !== baseline.sig) deps.store.upsertWatchState(run.id, step.name, "read_only", { sig: head });
    return { kind: "ok" };
  }
  if (head === baseline.sig) return { kind: "ok" };
  return {
    kind: "trip",
    trippedWhat: "read-only contract",
    attentionReason: `${step.name} is read-only but committed (HEAD moved)`,
    body: `${run.ticketKey}: the ${step.name} step is read-only — it must never edit or commit — but the branch HEAD moved from ${baseline.sig.slice(0, 8)} to ${head.slice(0, 8)} after its agent took over. A human should review; the agent violated the read-only contract. (A genuine step-done from this step will un-park and advance.)`,
    detail: { step: step.name, baseline: baseline.sig, head },
  };
};

/** Evaluators by guard KIND. A GuardSpec on a step's guards + an evaluator here = a fully-wired
 *  watch: attach conditions, the park, the rescue class, resume refunds and the obligations facts
 *  all derive from the declaration. (A registration function for plugin kinds is the planned next
 *  step; today the map is closed over the shipped three.) */
const WATCH_EVALUATORS = new Map<string, WatchEvaluator>([
  ["budget", budgetEvaluate],
  ["heartbeat", heartbeatEvaluate],
  ["read_only", readOnlyEvaluate],
]);

export function watchEvaluatorFor(kind: string): WatchEvaluator | undefined {
  return WATCH_EVALUATORS.get(kind);
}

/** Each watch kind's re-base: what a fresh clock means FOR IT. Writes the watch_state row (nulls
 *  to clear — never a delete, so the legacy fallback can't resurrect a cleared clock). A plugin
 *  watch with richer state re-bases via its own entry here (see registerWatchEvaluator's docs). */
const WATCH_REBASE: Record<string, (deps: Deps, runId: number, step: string) => void> = {
  budget: (deps, runId, step) => void deps.store.upsertWatchState(runId, step, "budget", { basedAt: deps.now() }),
  heartbeat: (deps, runId, step) => void deps.store.upsertWatchState(runId, step, "heartbeat", { sig: null, basedAt: null }),
  read_only: (deps, runId, step) => void deps.store.upsertWatchState(runId, step, "read_only", { sig: null, basedAt: null }),
};

/**
 * Re-base every armed watch's clocks for one engine seam, derived from the guards' `rebaseOn`
 * declarations — the RWR-18147 fix as data. Each seam names its trigger and this applies the right
 * subset: an "entry" resets all three; a "reply_resume" re-bases only the budget (the agent
 * CONTINUES its pass — the frozen read-only baseline and the stall history must survive). Seam
 * bookkeeping (done / pass / dispatched_at / absent_at) stays at the seams — it is pass state,
 * not a watch clock. A step with none of the declaring guards is a no-op.
 */
export function applyWatchRebase(deps: Deps, runId: number, step: StepConfig, trigger: WatchRebaseTrigger): void {
  for (const g of step.guards) {
    if (!g.rebaseOn?.includes(trigger)) continue;
    WATCH_REBASE[g.kind]?.(deps, runId, step.name);
  }
}

/**
 * Evaluate the step's armed watches for one stage, in guard-declaration order, first trip wins.
 * The harness owns the declared working-pane veto: a trip from a `vetoWhenWorking` watch is held
 * while the step's agent is actively `working` — a LIVE agent is never parked by a timer; only a
 * genuinely idle or dead one is. (The trade, documented since the long-horizon policy landed: a
 * working-but-wedged agent that never commits is not caught by the stall timer — the dead-pane
 * recovery and the operator remain its backstops.) Herdr being unreachable defers the whole pass:
 * a false "gone" would park a healthy run.
 */
export async function evaluateStepWatches(
  deps: Deps,
  run: Run,
  step: StepConfig,
  rs: RunStep,
  stage: "pre_advance" | "watchdog",
): Promise<WatchOutcome> {
  let worker: string | null = null; // pane state, resolved at most once per pass (for the veto)
  for (const g of step.guards) {
    if ((g.stage ?? "watchdog") !== stage) continue;
    const evaluate = WATCH_EVALUATORS.get(g.kind);
    if (!evaluate) continue; // spawn-phase / signal-driven / non-watchdog guards aren't walked here
    const verdict = await evaluate({ deps, run, step, rs });
    if (verdict.kind === "ok") continue;
    if (verdict.kind === "defer") {
      deps.log("warn", `${run.ticketKey}: ${step.name} ${g.kind} watch deferred — ${verdict.why}`);
      return { action: "defer" };
    }
    if (g.vetoWhenWorking) {
      if (worker === null) {
        try {
          worker = rs.paneId ? await deps.herdr.paneState(rs.paneId) : "gone";
        } catch (e) {
          if (e instanceof HerdrUnreachableError) {
            // Can't judge the worker while herdr is unreachable — a false "gone" here would park
            // a healthy run in attention. Defer the whole watchdog to a later tick.
            deps.log("warn", `${run.ticketKey}: ${step.name} watchdog deferred — ${e.message}`);
            return { action: "defer" };
          }
          throw e;
        }
      }
      if (worker === "working") {
        return { action: "extend", note: `${run.ticketKey}: ${step.name} past ${verdict.trippedWhat} but still working — extending` };
      }
    }
    const fill = (s: string) => s.replaceAll("@@WORKER@@", worker ?? "unknown");
    return {
      action: "park",
      reason: g.escalationReason,
      attentionReason: fill(verdict.attentionReason),
      body: fill(verdict.body),
      detail: g.vetoWhenWorking ? { ...(verdict.detail ?? {}), worker } : verdict.detail,
    };
  }
  return { action: "none" };
}
