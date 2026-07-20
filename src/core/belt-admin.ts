// Belt lifecycle admin — the cleanup that runs when a belt is RENAMED or DELETED. A belt's identity
// is its `name`; a run records that name in runs.belt at claim and never updates it, so a bare
// config edit that renames or drops a belt would orphan its in-flight runs (their belt no longer
// resolves → the reconciler parks them for `attention` with reason `belt_missing`). These helpers
// make the two operations clean instead:
//
//   • rename → migrate every run (active AND historical) from the old belt name to the new one, so
//     nothing orphans and the dashboard/timeline/history stay coherent under the new name.
//   • delete → BLOCKED while the belt has any in-flight run; otherwise reap any leaked worktree for
//     its ended runs and purge the belt's run rows + child rows (the events timeline is KEPT).
//
// These functions do NOT lock or reload — the caller (server ctx / CLI fallback) runs them under
// the repo tick lock and reloads Deps atomically afterward, so no reconcile pass sees a half-applied
// change (a run whose new belt name isn't configured yet, or a belt claiming into a purge).
import type { Run } from "../types.ts";
import type { Deps } from "./deps.ts";
import { removeRunWorktree } from "./reconcile.ts";

/** Thrown by deleteBeltData when the belt still has in-flight work — the delete guard. Carries the
 *  count so the caller (server → TUI) can name it in a friendly message. */
export class BeltHasActiveRunsError extends Error {
  readonly belt: string;
  readonly activeRuns: number;
  constructor(belt: string, activeRuns: number) {
    super(`belt "${belt}" has ${activeRuns} run(s) in progress — let them finish or tear them down before deleting it`);
    this.name = "BeltHasActiveRunsError";
    this.belt = belt;
    this.activeRuns = activeRuns;
  }
}

/** How many in-flight runs a belt has (0 ⇒ deletable). The delete guard's read side — used by the
 *  TUI/CLI pre-check and by the reload-time guard. */
export function activeRunCountForBelt(deps: Deps, belt: string): number {
  return deps.store.activeRunsForBelt(deps.config.repoName, belt).length;
}

/** Migrate all runs (active + historical) from one belt name to another. Returns how many moved.
 *  Records a repo-scoped `belt_reassigned` audit event. Idempotent. */
export function renameBeltRuns(deps: Deps, from: string, to: string): { runsMoved: number } {
  const repo = deps.config.repoName;
  const runsMoved = deps.store.reassignBelt(repo, from, to);
  deps.store.recordEvent({ repo, type: "belt_reassigned", detail: { from, to, runsMoved } });
  deps.log("info", `belt rename "${from}" → "${to}": migrated ${runsMoved} run(s)`);
  return { runsMoved };
}

/** Delete a belt's data. Throws BeltHasActiveRunsError if it still has an in-flight run (the delete
 *  guard). Otherwise reaps any LEAKED worktree for the belt's ended runs (defensive — teardown
 *  normally already did), then purges the belt's run rows + child rows, KEEPING the events timeline.
 *  Records a `belt_deleted` audit event. Idempotent (a second call finds no runs → purges nothing). */
export async function deleteBeltData(deps: Deps, belt: string): Promise<{ runsPurged: number; worktreesCleaned: number }> {
  const repo = deps.config.repoName;
  const active = deps.store.activeRunsForBelt(repo, belt);
  if (active.length > 0) throw new BeltHasActiveRunsError(belt, active.length);

  let worktreesCleaned = 0;
  for (const run of deps.store.endedRunsForBelt(repo, belt)) {
    try {
      await removeRunWorktree(deps, run);
      worktreesCleaned++;
    } catch (e) {
      // A leaked worktree we couldn't reap must not block the DB purge — log and continue.
      deps.log("warn", `belt "${belt}": could not clean a leaked worktree for run ${run.id} (${run.ticketKey}) — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const runsPurged = deps.store.purgeBeltRuns(repo, belt);
  deps.store.recordEvent({ repo, type: "belt_deleted", detail: { belt, runsPurged, worktreesCleaned } });
  deps.log("info", `belt "${belt}": deleted — purged ${runsPurged} run(s), cleaned ${worktreesCleaned} leaked worktree(s)`);
  return { runsPurged, worktreesCleaned };
}

/** A belt-set change to apply against a repo whose config file has ALREADY been written with the
 *  new belts. `renames` migrate first; `deletes` are the belts removed from config (their data is
 *  purged, guarded). Both are computed by the caller from the old→new belt diff. */
export interface BeltChanges {
  renames: { from: string; to: string }[];
  deletes: string[];
}

/** Result of applying belt changes — surfaced to the operator (TUI/CLI). `blocked` names any
 *  delete refused by the guard (still had in-flight work); those belts were left untouched. */
export interface BeltChangesResult {
  runsMoved: number;
  runsPurged: number;
  worktreesCleaned: number;
  blocked: { belt: string; activeRuns: number }[];
}

/** Apply a belt-set change against `deps` (no lock, no reload — the caller owns both). **Guard
 *  first, all-or-nothing:** if ANY deleted belt still has in-flight work, NOTHING is applied — no
 *  rename migrates and no belt is purged — and the blocked belts are returned so the caller can
 *  refuse the whole config change (reverting the file) rather than leave it half-applied. Only when
 *  every delete is clear does it migrate the renames and purge the deletes. Used by the server's
 *  atomic apply and the in-process fallback alike. */
export async function applyBeltChanges(deps: Deps, changes: BeltChanges): Promise<BeltChangesResult> {
  const result: BeltChangesResult = { runsMoved: 0, runsPurged: 0, worktreesCleaned: 0, blocked: [] };
  // Guard pass first — a single busy delete aborts the whole change, so a rename never migrates
  // runs the caller is about to revert (which would orphan them).
  for (const belt of changes.deletes) {
    const activeRuns = activeRunCountForBelt(deps, belt);
    if (activeRuns > 0) result.blocked.push({ belt, activeRuns });
  }
  if (result.blocked.length > 0) return result;
  // All deletes are clear — apply. (deleteBeltData re-checks the guard; a TOCTOU claim between the
  // pass above and here would surface as its BeltHasActiveRunsError, which we re-collect.)
  for (const { from, to } of changes.renames) {
    result.runsMoved += renameBeltRuns(deps, from, to).runsMoved;
  }
  for (const belt of changes.deletes) {
    try {
      const { runsPurged, worktreesCleaned } = await deleteBeltData(deps, belt);
      result.runsPurged += runsPurged;
      result.worktreesCleaned += worktreesCleaned;
    } catch (e) {
      if (e instanceof BeltHasActiveRunsError) result.blocked.push({ belt: e.belt, activeRuns: e.activeRuns });
      else throw e;
    }
  }
  return result;
}

/** Belt-name diff between two configs (old → new), reused by the TUI save path and the reload-time
 *  guard. A rename is inferred ONLY when it's unambiguous: exactly one belt name disappeared and one
 *  appeared, and their bodies (every field except `name`) are identical — so a rename tangled with
 *  an edit, or several at once, degrades safely to delete+add (the delete guard then catches any
 *  busy ones). `deletes` are removed belts that WEREN'T part of an inferred rename. */
export function diffBelts(
  oldBelts: Record<string, unknown>[],
  newBelts: Record<string, unknown>[],
): { renames: { from: string; to: string }[]; deletes: string[]; adds: string[] } {
  const nameOf = (b: Record<string, unknown>) => String(b.name ?? "");
  const oldNames = new Set(oldBelts.map(nameOf));
  const newNames = new Set(newBelts.map(nameOf));
  const removed = [...oldNames].filter((n) => n && !newNames.has(n));
  const added = [...newNames].filter((n) => n && !oldNames.has(n));
  if (removed.length === 1 && added.length === 1) {
    const from = removed[0]!;
    const to = added[0]!;
    const oldBody = bodyWithoutName(oldBelts.find((b) => nameOf(b) === from)!);
    const newBody = bodyWithoutName(newBelts.find((b) => nameOf(b) === to)!);
    if (oldBody === newBody) return { renames: [{ from, to }], deletes: [], adds: [] };
  }
  return { renames: [], deletes: removed, adds: added };
}

/** Stable JSON of a belt with its `name` stripped — the rename body-equality probe in diffBelts.
 *  Keys are sorted so field order in the YAML doesn't defeat the comparison. */
function bodyWithoutName(belt: Record<string, unknown>): string {
  const keys = Object.keys(belt)
    .filter((k) => k !== "name")
    .sort();
  return JSON.stringify(keys.map((k) => [k, belt[k]]));
}
