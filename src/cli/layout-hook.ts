// Lean entry for the herdr layout event hook (worktree.created / workspace.created /
// workspace.focused). Kept OUT of src/cli/index.ts so the constantly-firing focus event pays only
// Node startup + a tiny import graph — runLayoutHook lazy-loads the heavy modules (herdr client,
// buildDeps, the layout runner) only once it actually has a fresh worktree to build into.
import { runLayoutHook } from "../core/layout-hook.ts";

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
