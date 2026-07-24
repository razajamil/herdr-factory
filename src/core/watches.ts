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
import type { Run, RunStep, RunStepPatch, WatchRebaseTrigger } from "../types.ts";

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

/** budget: the per-step wall clock (rs.startedAt re-bases at every (re-)entry — RWR-18147). */
const budgetEvaluate: WatchEvaluator = async ({ deps, step, rs }) => {
  if (rs.startedAt == null || deps.now() - rs.startedAt <= step.budgetSeconds) return { kind: "ok" };
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
  let active = rs;
  if (run.worktreePath) {
    const sha = await deps.git.headSha(run.worktreePath);
    if (sha && sha !== rs.progressSig) active = deps.store.upsertRunStep(run.id, step.name, { progressSig: sha, progressAt: deps.now() });
  }
  const stalled = active.progressSig != null && active.progressAt != null && deps.now() - active.progressAt > deps.config.limits.stallSeconds;
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
  if (!step.readOnly || !rs.baselineSig || !run.worktreePath) return { kind: "ok" };
  const head = await deps.git.headSha(run.worktreePath).catch(() => null);
  if (!head) return { kind: "ok" };
  if (rs.baselineFrozenAt == null) {
    // Not yet frozen. Freeze at the current HEAD the first pass this step's agent is `working`;
    // until then keep the baseline synced to HEAD so the prior step's trailing commits absorb.
    // Herdr flaky here defers only the FREEZE (treat as not-working), never the whole pass.
    let working = false;
    try {
      working = rs.paneId != null && (await deps.herdr.paneState(rs.paneId)) === "working";
    } catch (e) {
      if (!(e instanceof HerdrUnreachableError)) throw e;
    }
    if (working) deps.store.upsertRunStep(run.id, step.name, { baselineSig: head, baselineFrozenAt: deps.now() });
    else if (head !== rs.baselineSig) deps.store.upsertRunStep(run.id, step.name, { baselineSig: head });
    return { kind: "ok" };
  }
  if (head === rs.baselineSig) return { kind: "ok" };
  return {
    kind: "trip",
    trippedWhat: "read-only contract",
    attentionReason: `${step.name} is read-only but committed (HEAD moved)`,
    body: `${run.ticketKey}: the ${step.name} step is read-only — it must never edit or commit — but the branch HEAD moved from ${rs.baselineSig.slice(0, 8)} to ${head.slice(0, 8)} after its agent took over. A human should review; the agent violated the read-only contract. (A genuine step-done from this step will un-park and advance.)`,
    detail: { step: step.name, baseline: rs.baselineSig, head },
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

/** Each watch kind's CLOCK columns, as a re-base patch. (With a future per-watch state table this
 *  collapses to a generic row reset; today the clocks live on run_steps columns.) */
const WATCH_CLOCKS: Record<string, (now: number) => RunStepPatch> = {
  budget: (now) => ({ startedAt: now }),
  heartbeat: () => ({ progressSig: null, progressAt: null }),
  read_only: () => ({ baselineSig: null, baselineFrozenAt: null }),
};

/**
 * Re-base every armed watch's clocks for one engine seam, derived from the guards' `rebaseOn`
 * declarations — the RWR-18147 fix as data. Each seam names its trigger and this applies the right
 * subset: an "entry" clears all three; a "reply_resume" re-bases only the budget (the agent
 * CONTINUES its pass — the frozen read-only baseline and the stall history must survive). Seam
 * bookkeeping (done / pass / dispatched_at / absent_at) stays at the seams — it is pass state,
 * not a watch clock. One upsert; a step with none of the declaring guards is a no-op.
 */
export function applyWatchRebase(deps: Deps, runId: number, step: StepConfig, trigger: WatchRebaseTrigger): void {
  let patch: RunStepPatch = {};
  for (const g of step.guards) {
    if (!g.rebaseOn?.includes(trigger)) continue;
    const clocks = WATCH_CLOCKS[g.kind];
    if (clocks) patch = { ...patch, ...clocks(deps.now()) };
  }
  if (Object.keys(patch).length > 0) deps.store.upsertRunStep(runId, step.name, patch);
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
