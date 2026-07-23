// The Phase-0 flush driver: the pass shape every durable-intent outbox shares. A leaf module so
// both the legacy flows (reconcile.ts) and the intent-ledger kernel (core/ledger.ts) plug into the
// same driver without an import cycle.
import type { Deps } from "./deps.ts";

/** One durable-intent outbox the Phase 0 flush drives. The DRIVER (`flushOutbox`) owns the pass
 *  shape — run the optional pre-pass hook, walk the due rows, isolate per-row failures — while each
 *  flow keeps its own delivery semantics (per-run FIFO gates, terminal vocabulary, error
 *  classification, notify policy) inside `attempt`. Every flow is LOCK-FREE by contract: it must
 *  never mutate a run — only its own rows + events + best-effort notifies (a run-policy reaction
 *  crosses to the run-locked Phase A, e.g. the stale two-phase). Adding outbox N+1 is one more
 *  entry in `outboxFlows`, not a third copy of the loop. */
export interface OutboxFlow<J> {
  readonly name: string;
  /** Runs once before the due rows are walked (creds-recovery probes + due-now requeues). */
  prePass?(): Promise<void>;
  /** Rows due for a delivery attempt this pass. */
  due(): J[];
  /** One row's delivery attempt. Owns its outcome bookkeeping entirely — delivered / backoff /
   *  terminal stamp / throttled notify. Expected failures must be RECORDED, never thrown: a throw
   *  here is a flow bug, which the driver logs and skips so one bad row can't stall the pass. */
  attempt(job: J): Promise<void>;
}

export async function flushOutbox<J>(deps: Deps, flow: OutboxFlow<J>): Promise<void> {
  if (flow.prePass) await flow.prePass();
  for (const job of flow.due()) {
    try {
      await flow.attempt(job);
    } catch (e) {
      deps.log("error", `${flow.name} flush: attempt failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
