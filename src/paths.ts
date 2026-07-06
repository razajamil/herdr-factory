// Leaf path utilities with NO project imports. Source descriptors need these at resolve time,
// and descriptors are imported by the registry, which config.ts evaluates at module init — so
// anything descriptors import must never (transitively) import config.ts back: entering that
// cycle from the registry side would hit config.ts's init-time SOURCE_DESCRIPTORS read before
// the registry finished initializing (a TDZ ReferenceError, order-dependent on which module a
// given entrypoint happens to import first).
import { homedir } from "node:os";
import { join } from "node:path";

/** Expand a leading `~`/`~/` and any `$HOME`/`${HOME}` to the home directory. Absolute paths and
 *  paths without those tokens are returned unchanged, so it's a safe no-op for already-absolute
 *  config values. Applied uniformly to repo.path and source folder paths. */
export function expandHome(p: string): string {
  let out = p;
  if (out === "~" || out.startsWith("~/")) out = join(homedir(), out.slice(1));
  out = out.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, homedir());
  return out;
}
