// The single engine-effect implementation for the run-scoped agent→dispatcher signals
// (step-done · ask-human · bounce · capture-attempt). BOTH the HTTP handler (server/app.ts) and the
// CLI's in-process fallback (cli/index.ts) call this ONE function, so the two can't drift and the
// per-signal lock discipline — declared as data in SIGNAL_DESCRIPTORS (test-pinned in
// test/step-descriptor-contract.test.ts) — is applied in exactly one place instead of hand-picked
// per call site in each of two files. Adding a run-scoped signal is now: one SIGNAL_DESCRIPTORS
// entry + one `case` here + its route's body/response schema; the server/CLI mounting is generic.
//
// (evidence-upload is intentionally NOT here: it is a `product-outbox` signal that does CLI-local S3
// work, not a run-lock nudge — see cli/index.ts.)
import type { Deps } from "./deps.ts";
import { resolveActiveRun } from "../resolve.ts";
import { stepByName } from "./step.ts";
import { bounceStep, reconcileRun, recordCaptureAttempt, requestHumanInput, withRunLock, withRunLockWaiting } from "./reconcile.ts";

/** The parsed body an agent signal carries — a superset; each signal reads only the fields it needs.
 *  Structurally compatible with every run-scoped route's validated JSON body (StepDoneBody, …). */
export interface SignalBody {
  key: string;
  step?: string;
  toStep?: string;
  source?: string;
  question?: string;
  reason?: string;
}

/** The union of fields the run-scoped signal responses use; each branch fills only its own. Messages
 *  are BARE (no key prefix) — callers prefix the key when they surface them. */
export interface SignalResult {
  ok: boolean;
  advanced?: boolean; // step-done: did the nudge reconcile the run on this call?
  questionId?: number; // ask-human
  posted?: boolean; // ask-human: was the question posted to the source (vs deferred)?
  attempts?: number; // capture-attempt: attempts recorded this pass
  escalated?: boolean; // bounce / capture-attempt: cap hit → parked for attention
  message?: string;
}

/** The `waiting` tail shared by the non-monotonic signals (lockDiscipline "waiting"): run `effect`
 *  under this run's lock, serialized against the tick's pass over the run; report it busy if the
 *  lock can't be taken (the agent retries; the next tick is the backstop). */
async function underRunLockWaiting(deps: Deps, runId: number, name: string, effect: () => Promise<SignalResult>): Promise<SignalResult> {
  const { ran, result } = await withRunLockWaiting(deps, runId, effect);
  return ran ? result! : { ok: false, message: `run busy — retry ${name} in a moment` };
}

/** Apply a run-scoped agent signal to its run: resolve the run, then run the per-signal effect under
 *  the lock discipline the signal declares. Returns a bare-message result the caller renders. */
export async function applySignal(deps: Deps, name: string, body: SignalBody): Promise<SignalResult> {
  const repo = deps.config.repoName;
  const run = resolveActiveRun(deps, body.key, body.source);
  if (!run) {
    deps.log("warn", `${body.key}: no active run for ${name}`);
    return { ok: false, message: "no active run" };
  }
  const fresh = () => deps.store.getRun(run.id)!;
  switch (name) {
    case "step-done": {
      const step = body.step!;
      const belt = deps.resolveBelt(run.belt);
      if (belt && !stepByName(belt, step)) return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
      deps.store.markStepDone(run.id, step);
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: body.key, type: "step_done", detail: { step } });
      deps.log("info", `${body.key}: step-done ${step} recorded`);
      // fire-and-forget (lockDiscipline "fire-and-forget"): the done flag is a monotonic edge, so a
      // per-run lock is enough — the nudge lands even mid-tick, and if this run is busy the next pass
      // advances it.
      const advanced = await withRunLock(deps, run.id, () => reconcileRun(deps, fresh()));
      if (!advanced) deps.log("info", `${body.key}: run busy — the next pass will advance the belt`);
      return { ok: true, advanced };
    }
    case "ask-human": {
      const step = body.step!;
      const belt = deps.resolveBelt(run.belt);
      if (belt && !stepByName(belt, step)) return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
      // Non-monotonic phase flip (running → waiting_for_human): a concurrent reconcile on a stale
      // `running` snapshot could advance the step and orphan the question, so hold the run lock.
      return underRunLockWaiting(deps, run.id, name, async () => {
        const res = await requestHumanInput(deps, fresh(), step, body.question!);
        await reconcileRun(deps, fresh());
        return res;
      });
    }
    case "bounce": {
      const belt = deps.resolveBelt(run.belt);
      if (!belt) return { ok: false, message: `run has no configured belt "${run.belt}"` };
      const src = deps.resolveSource(run.workSource);
      if (!src) return { ok: false, message: `run has no configured work source "${run.workSource}"` };
      // Step rewind + pane re-dispatch — serialize under the run lock, not a fire-and-forget nudge.
      return underRunLockWaiting(deps, run.id, name, () => bounceStep(deps, fresh(), belt, src, body.toStep!, body.reason!));
    }
    case "capture-attempt": {
      const belt = deps.resolveBelt(run.belt);
      if (!belt) return { ok: false, message: `run has no configured belt "${run.belt}"` };
      // Past the cap this parks the run (a non-monotonic phase flip) — hold the run lock like bounce.
      return underRunLockWaiting(deps, run.id, name, () => recordCaptureAttempt(deps, fresh(), belt, body.step!));
    }
    default:
      throw new Error(`unknown run-scoped signal "${name}"`);
  }
}
