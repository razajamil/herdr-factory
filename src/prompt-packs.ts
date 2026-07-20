import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// User-overridable prompt packs — the repo-level prompt-resolution chain.
//
// A step's (or the PR resolver's) ENGINE BASE prompt is resolved by walking override layers,
// highest precedence first, falling back to the engine's shipped prompt (which always exists). A
// "pack" is just a directory of override files keyed by the base slug, mirroring the shipped
// library's layout:
//     <pack>/<sourceType>/<slug>.md   per-source specialization (only when perSourceOverride)
//     <pack>/<slug>.md                the shared variant
//
// The chain, highest precedence first:
//   1. repo checkout   — <worktree>/.herdr/prompts/   (version-controlled next to the code)
//   2. config folder   — <configFolder>/prompts/      (repos/<name>/prompts/)
//   3. engine shipped  — src/prompts/                 (always present — the final fallback)
//
// The FIRST file found wins and REPLACES the shipped base — distinct from a step's `prompt_file`,
// which AUGMENTS whatever base wins (both compose: override the base pack AND augment per step).
//
// The repo-checkout layer lives in the run's worktree, which doesn't exist at config-load time, so
// it's only reachable at RENDER time: config-load resolves layers 2–3 (baked into `enginePrompt`)
// and the render step layers the worktree pack on top. This module is an import-free leaf (node
// builtins only) so config.ts and the core render/watch paths can all share the same chain.

/** Pack subdir inside the repo's config folder (repos/<name>/) — shares the folder custom-step
 *  `prompt_file`s live in, so `prompts/work.md` there overrides the shipped `work` base. */
export const CONFIG_PACK_SUBDIR = "prompts";
/** Pack subdir inside the target repo checkout (the run's worktree). */
export const REPO_PACK_SUBDIR = ".herdr/prompts";
/** The engine's shipped prompt library (src/prompts/). Always the final fallback in the chain. */
export const SHIPPED_PROMPTS_DIR = fileURLToPath(new URL("prompts/", import.meta.url));

/** Candidate files for `slug` within one pack dir, per-source-typed first when `perSourceOverride`. */
function candidates(dir: string, sourceType: string, slug: string, perSourceOverride: boolean): string[] {
  const shared = join(dir, `${slug}.md`);
  return perSourceOverride && sourceType ? [join(dir, sourceType, `${slug}.md`), shared] : [shared];
}

/** Walk `dirs` (highest precedence first) and return the first existing prompt file's body + path,
 *  or undefined if none of them has one. Pass {@link SHIPPED_PROMPTS_DIR} as the last dir to
 *  guarantee a hit for a real slug. Within a single dir, the per-source-typed file beats the shared
 *  one (when `perSourceOverride`). */
export function resolvePromptFile(
  dirs: string[],
  sourceType: string,
  slug: string,
  perSourceOverride: boolean,
): { path: string; body: string } | undefined {
  for (const dir of dirs) {
    for (const path of candidates(dir, sourceType, slug, perSourceOverride)) {
      if (existsSync(path)) return { path, body: readFileSync(path, "utf8") };
    }
  }
  return undefined;
}

/** The user-override layers (excluding the shipped fallback), highest precedence first: the repo
 *  checkout's pack when a worktree exists, then the config folder's pack. Append
 *  {@link SHIPPED_PROMPTS_DIR} for a chain that always resolves. */
export function packLayers(worktree: string | undefined, configFolder: string): string[] {
  const layers: string[] = [];
  if (worktree) layers.push(join(worktree, REPO_PACK_SUBDIR));
  layers.push(join(configFolder, CONFIG_PACK_SUBDIR));
  return layers;
}
