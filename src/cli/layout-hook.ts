// Lean entry for the herdr layout hooks. Kept OUT of src/cli/index.ts so the constantly-firing
// focus event pays only Node startup + a tiny import graph — runLayoutHook lazy-loads the heavy
// modules (herdr client, buildDeps, the layout runner) only once it actually has a fresh worktree to
// build into.
//
// Two modes, both routed here by bin/herdr-factory:
//   • no args   — an EVENT hook (worktree.created / workspace.created / workspace.focused)
//   • --startup — the one-shot [[startup]] hook: per-server-session state hygiene only, and no herdr
//                 calls at all (it runs while the server is still coming up).
import { runLayoutHook, runLayoutStartup } from "../core/layout-hook.ts";

if (process.argv.includes("--startup")) {
  const { reaped, decidedCleared } = runLayoutStartup();
  // The setup-status reaper lives with the layout runner (it owns those files); imported lazily so the
  // hot event path below never pays for that module's graph.
  const { reapSetupStatusFiles } = await import("../core/layout.ts");
  const statuses = reapSetupStatusFiles();
  const parts = [`reaped ${reaped} orphan claim(s)`];
  if (decidedCleared) parts.push("cleared the decided cache");
  if (statuses > 0) parts.push(`reaped ${statuses} setup status file(s)`);
  console.log(`[layout-hook] startup: ${parts.join(", ")}`);
  process.exit(0);
}

runLayoutHook(process.env)
  .then((res) => {
    if (res.applied) console.log(`applied layout "${res.applied}"`);
    else if (res.skipped) console.error(`[layout-hook] ${res.skipped}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[layout-hook] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
