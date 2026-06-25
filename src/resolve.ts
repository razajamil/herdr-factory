import type { Deps } from "./core/deps.ts";
import type { Run } from "./types.ts";

// Pure resolvers shared by the CLI (which catches and exits) and the server (which catches and
// returns an HTTP error). They THROW rather than process.exit, so they're safe in a long-lived
// process.

/** The belt name for a manual `claim`: the explicit `optBelt` (validated), else the sole
 *  configured belt, else throw asking which one. */
export function resolveBeltName(deps: Deps, optBelt?: string): string {
  if (optBelt) {
    if (!deps.belts.some((b) => b.name === optBelt)) {
      throw new Error(`unknown belt "${optBelt}"; configured: ${deps.belts.map((b) => b.name).join(", ")}`);
    }
    return optBelt;
  }
  if (deps.belts.length === 1) return deps.belts[0]!.name;
  throw new Error(`multiple belts configured — pass --belt <name> (one of: ${deps.belts.map((b) => b.name).join(", ")})`);
}

/** Resolve a single active run by key for a manual mutation, throwing on cross-source ambiguity. */
export function resolveActiveRun(deps: Deps, key: string, optSource?: string): Run | undefined {
  const repo = deps.config.repoName;
  if (optSource) return deps.store.activeRunForTicket(repo, optSource, key);
  const runs = deps.store.activeRunsForKey(repo, key);
  if (runs.length > 1) {
    throw new Error(`${key}: active in multiple sources (${runs.map((r) => r.workSource).join(", ")}) — pass --source <name>`);
  }
  return runs[0];
}
