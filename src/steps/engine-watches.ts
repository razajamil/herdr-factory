// Watches the ENGINE arms on every step, regardless of what its descriptor declares. These are not
// GuardSpecs — they have no per-step attach conditions, no counter in guard_counters, and no
// attention reason of their own — but they ARE part of the answer to "what is watching this run",
// so they're declared here (completing the guard registry's coverage) for introspection surfaces
// and so their numbers live in one place instead of as reconciler-local constants. A LEAF module.

/** How long a step's pane must stay CONFIRMED absent before the reconciler respawns it: two
 *  confirmed observations at least this far apart are required — long enough to ride out a herdr
 *  daemon restart, short enough that a genuinely dead pane restarts within ~a tick. Herdr being
 *  UNREACHABLE defers the check entirely (unreachable ≠ dead — see reconcileStep's liveness
 *  branch and docs/ARCHITECTURE.md §8). */
export const PANE_ABSENCE_CONFIRM_SECONDS = 45;

/** One engine-universal watch: what it observes and how its trip recovers. */
export interface EngineWatch {
  readonly kind: string;
  readonly watches: string;
  readonly rescue: string;
}

export const ENGINE_WATCHES: readonly EngineWatch[] = [
  {
    kind: "pane_liveness",
    watches: `the active step's pane is present in herdr's agent list — tri-state: unreachable herdr defers, a first confirmed absence only stamps run_steps.absent_at, and only a second confirmed absence ≥${PANE_ABSENCE_CONFIRM_SECONDS}s later acts`,
    rescue: "respawn the step's agent (a done step is never relaunched; a failed respawn hands the retry to the bounded layout wait)",
  },
  {
    kind: "pass_staleness",
    watches: "agent terminal signals carry the --pass stamp of the prompt that minted them (run_steps.pass) — bounce rewinds make per-step progress non-monotonic, so 'done' alone is not idempotent across passes",
    rescue: "none — a stale-pass signal is rejected loudly; the live pass's own signal applies",
  },
];
