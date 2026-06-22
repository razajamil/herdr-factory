import type { Deps } from "./core/deps.ts";
import type { Run } from "./types.ts";

// Pure resolvers shared by the CLI (which catches and exits) and the server (which catches and
// returns an HTTP error). They THROW rather than process.exit, so they're safe in a long-lived
// process.

/** The source name for a manual command: the explicit `optSource` (validated), else the sole
 *  configured source, else throw asking which one. */
export function resolveSourceName(deps: Deps, optSource?: string): string {
  if (optSource) {
    if (!deps.sources.some((s) => s.name === optSource)) {
      throw new Error(`unknown source "${optSource}"; configured: ${deps.sources.map((s) => s.name).join(", ")}`);
    }
    return optSource;
  }
  if (deps.sources.length === 1) return deps.sources[0]!.name;
  throw new Error(`multiple sources configured — pass --source <name> (one of: ${deps.sources.map((s) => s.name).join(", ")})`);
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
