import type { DatabaseSync } from "node:sqlite";

/**
 * Run `fn` inside a transaction — COMMIT on success, ROLLBACK on throw — returning whatever
 * `fn` returns. node:sqlite (unlike better-sqlite3) ships no `.transaction()` helper, so we wrap
 * BEGIN/COMMIT/ROLLBACK by hand. `IMMEDIATE` takes the write lock up front: the correct choice for
 * the read-then-write transactions here (e.g. `acquireLock`) under WAL + multi-process access,
 * where a deferred read→write upgrade can fail with SQLITE_BUSY. No call site nests transactions,
 * so a single level suffices.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* best-effort: the transaction may already be aborted */
    }
    throw err;
  }
}
