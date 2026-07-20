// Client-side entry for applying a belt rename/delete cleanup, used by the TUI config editor (and
// available to the CLI). Routes through the running server — which does it ATOMICALLY under the repo
// tick lock and reloads its Deps — or, when no server is up, runs the same core logic in-process
// against a fresh Deps under the tick lock. Either way the config.yml file must already be written
// with the new belts (the caller reverts it if `blocked`/`failures` come back non-empty).
import { buildDeps } from "./build-deps.ts";
import { applyBeltChanges, type BeltChanges, type BeltChangesResult } from "./core/belt-admin.ts";
import { withTickLock } from "./core/reconcile.ts";
import { viaServerOrLocal } from "./server/client.ts";

export interface BeltApplyResult extends BeltChangesResult {
  ok: boolean;
  failures: { name: string; error: string }[];
}

/** Apply belt changes for `repo` (config.yml already written). Idempotent and safe to call with
 *  empty renames+deletes (returns a clean no-op). */
export async function applyBeltChangesForRepo(repo: string, changes: BeltChanges): Promise<BeltApplyResult> {
  const { data } = await viaServerOrLocal(
    { method: "POST", path: `/repos/${encodeURIComponent(repo)}/belt-apply`, body: changes },
    async (): Promise<BeltApplyResult> => {
      // No server: no running tick loop to race, so migrate/purge under the tick lock (a stray
      // one-shot `tick` still can't overlap) against a Deps built from the just-written config. No
      // reload is needed — the next `serve` start reads the new config cold.
      const deps = await buildDeps(repo);
      let result: BeltChangesResult = { runsMoved: 0, runsPurged: 0, worktreesCleaned: 0, blocked: [] };
      const ran = await withTickLock(deps, async () => {
        result = await applyBeltChanges(deps, changes);
      });
      const failures = ran ? [] : [{ name: repo, error: "repo busy (tick in flight) — retry" }];
      return { ...result, ok: result.blocked.length === 0 && failures.length === 0, failures };
    },
  );
  return data as BeltApplyResult;
}
