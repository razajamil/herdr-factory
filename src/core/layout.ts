// Layout matching, planning, and application — absorbed from the herdr-workspace-manager plugin.
//
// Three pure-ish pieces plus one effectful runner:
//   • resolveBeltLayout — pick the layout for a worktree from its belt (branch globs → default).
//   • buildPlan         — turn a layout into an ordered list of symbolic build steps (depth-first
//                         walk of tabs then panes), referencing panes/tabs by SYMBOLIC handles.
//   • splitRatioArg     — translate a pane `size`/`ratio` into herdr's `pane split --ratio`.
//   • applyLayout       — execute a plan against the live herdr server, mapping handles → real ids.
//
// The factory builds the layout into a freshly-created worktree (reconcileClaiming), so a step's
// `tab`/`pane` targeting resolves against panes the factory itself brought up rather than a
// hand-built herdr layout.

import type { LayoutConfig, LayoutSize } from "../config.ts";
import type { Deps } from "./deps.ts";
import { telemetrySpan } from "../telemetry/index.ts";

// Pure worktree→layout matching lives in the leaf ./layout-match.ts (so the lean event-hook entry
// can import it without this module's runner/telemetry graph). Re-exported here for existing callers.
export { globMatch, resolveBeltLayout, resolveHookLayout } from "./layout-match.ts";

// ── Planning: layout → ordered symbolic steps ────────────────────────────────────────────────────

// Symbolic handles the plan references (the runner maps these to real herdr ids as it executes,
// because a pane's real id is only known after `tab create` / `pane split` returns):
//   tab  ti  → "t0", "t1", …    ("t0" is the worktree's existing root tab)
//   pane pj  → "t<ti>p<pj>"      ("t0p0" is the worktree's existing root pane)
export const ROOT_TAB = "t0";
export const ROOT_PANE = "t0p0";
const tabHandle = (ti: number) => `t${ti}`;
const paneHandle = (ti: number, pj: number) => `t${ti}p${pj}`;

export type PlanStep =
  | { kind: "reuseTab"; tab: string; title?: string } // rename the worktree's existing root tab
  | { kind: "createTab"; tab: string; pane: string; title?: string; cwd?: string } // herdr tab create
  | { kind: "split"; pane: string; from: string; direction: "right" | "down"; ratio?: number; size?: LayoutSize; cwd?: string }
  | { kind: "renamePane"; pane: string; title: string }
  | { kind: "runSetup"; pane: string; command: string; blocking: boolean } // layout-level setup (+ wait when blocking)
  | { kind: "run"; pane: string; command: string };

/** Turn a normalized layout into the ordered step sequence a user would follow building it by hand.
 *  Because the walk is depth-first and a blocking RunSetup pauses the runner, putting `setup: true`
 *  on the first pane guarantees no other tab/pane spawns until setup finishes. (Ported from
 *  build_plan.) */
export function buildPlan(layout: LayoutConfig, cwd?: string): PlanStep[] {
  const steps: PlanStep[] = [];
  layout.tabs.forEach((tab, ti) => {
    const tHandle = tabHandle(ti);
    if (ti === 0) {
      steps.push({ kind: "reuseTab", tab: tHandle, title: tab.title });
    } else {
      steps.push({ kind: "createTab", tab: tHandle, pane: paneHandle(ti, 0), title: tab.title, cwd });
    }
    tab.panes.forEach((pane, pj) => {
      const pHandle = paneHandle(ti, pj);
      if (pj > 0) {
        steps.push({ kind: "split", pane: pHandle, from: paneHandle(ti, pj - 1), direction: pane.split ?? "right", ratio: pane.ratio, size: pane.size, cwd });
      }
      if (pane.title) steps.push({ kind: "renamePane", pane: pHandle, title: pane.title });
      // The single setup pane runs the layout-level setup command first (optionally blocking), then
      // its own command (if any).
      if (pane.setup && layout.setup) steps.push({ kind: "runSetup", pane: pHandle, command: layout.setup.command, blocking: layout.setup.blocking });
      if (pane.command) steps.push({ kind: "run", pane: pHandle, command: pane.command });
    });
  });
  return steps;
}

/** Clamp a split ratio into herdr's usable open interval (0, 1). A fixed cell size that meets or
 *  exceeds the available space would otherwise produce a degenerate 0-width pane. */
export function clampRatio(r: number): number | undefined {
  if (!Number.isFinite(r)) return undefined;
  return Math.min(0.99, Math.max(0.01, r));
}

/** The `--ratio` to pass to `herdr pane split`. herdr's ratio is the fraction the PREVIOUS (from)
 *  pane keeps; the new pane gets the rest. A pane's `size` sizes the NEW pane, so it's inverted:
 *  percent p → from keeps (1 - p/100); cells w → from keeps (1 - w/extent). `extent` is the from
 *  pane's live size along the split axis, needed only for a cell size. Legacy `ratio` (already the
 *  from-pane share) passes through. Returns a number in (0, 1), or undefined when nothing sizes the
 *  split (or a cell size can't be converted). */
export function splitRatioArg(ratio: number | undefined, size: LayoutSize | undefined, extent: number | undefined): number | undefined {
  if (ratio != null) return ratio;
  if (!size) return undefined;
  if ("percent" in size) return clampRatio(1 - size.percent / 100);
  if (extent == null || !Number.isFinite(extent) || extent <= 0) return undefined;
  return clampRatio(1 - size.cells / extent);
}

// ── Application: execute a plan against the live herdr server ─────────────────────────────────────

/** The worktree we build a layout INTO: its existing root tab + pane (from worktreeCreate) and the
 *  checkout path new tabs/panes should open in. */
export interface LayoutTarget {
  workspaceId: string;
  rootTabId: string;
  rootPaneId: string;
  cwd?: string;
}

// Give a freshly-spawned pane's shell a beat to be ready before typing into it, and cap a blocking
// setup command's wait (a hung setup must not wedge the claim forever).
const PANE_READY_MS = 700;
const SETUP_TIMEOUT_MS = 600_000;

/** Build a setup command wrapped with a completion sentinel printed after it. The marker is
 *  assembled by printf's `%s`, so the full literal never appears in the ECHOED command line — only
 *  in the command's actual output — which is what `herdr wait output` must match on (it also sees
 *  the echoed input, and would otherwise match immediately). (Ported from wrap_setup.) */
function wrapSetup(command: string, token: string): string {
  return `( ${command} ) ; printf 'HERDR_FACTORY_SETUP_DONE_%s %s\\n' '${token}' "$?"`;
}

/** Build `layout` into the target worktree via herdr (create tabs, split panes, run setup +
 *  commands). Emits a `layout.apply` span. Throws on the first herdr failure — the caller
 *  (reconcileClaiming) runs it best-effort so a layout hiccup logs rather than wedging the claim. */
export async function applyLayout(deps: Deps, target: LayoutTarget, layout: LayoutConfig): Promise<void> {
  return telemetrySpan(
    "layout.apply",
    { repo: deps.config.repoName, "herdr.workspace_id": target.workspaceId, "layout.id": layout.id },
    () => applyLayoutImpl(deps, target, layout),
  );
}

async function applyLayoutImpl(deps: Deps, target: LayoutTarget, layout: LayoutConfig): Promise<void> {
  const plan = buildPlan(layout, target.cwd);
  const handles = new Map<string, string>([
    [ROOT_TAB, target.rootTabId],
    [ROOT_PANE, target.rootPaneId],
  ]);
  const readied = new Set<string>();

  const resolvePane = (handle: string): string => {
    const id = handles.get(handle);
    if (!id) throw new Error(`layout "${layout.id}": unresolved pane handle "${handle}"`);
    return id;
  };
  const ensureReady = async (paneId: string): Promise<void> => {
    if (!readied.has(paneId)) {
      readied.add(paneId);
      if (PANE_READY_MS > 0) await deps.sleep(PANE_READY_MS);
    }
  };

  for (const step of plan) {
    switch (step.kind) {
      case "reuseTab": {
        const tabId = handles.get(step.tab);
        if (!tabId) throw new Error(`layout "${layout.id}": unresolved tab handle "${step.tab}"`);
        if (step.title) await deps.herdr.tabRename(tabId, step.title);
        break;
      }
      case "createTab": {
        const { tabId, paneId } = await deps.herdr.tabCreate(target.workspaceId, { label: step.title, cwd: step.cwd });
        handles.set(step.tab, tabId);
        handles.set(step.pane, paneId);
        break;
      }
      case "split": {
        const fromId = resolvePane(step.from);
        // A fixed cell size needs the from pane's live extent to become a ratio.
        const extent = step.size && "cells" in step.size ? await deps.herdr.paneExtent(fromId, step.direction) : null;
        const ratio = splitRatioArg(step.ratio, step.size, extent ?? undefined);
        const paneId = await deps.herdr.paneSplit(fromId, { direction: step.direction, ratio: ratio ?? undefined, cwd: step.cwd });
        handles.set(step.pane, paneId);
        break;
      }
      case "renamePane": {
        await deps.herdr.paneRename(resolvePane(step.pane), step.title);
        break;
      }
      case "runSetup": {
        const paneId = resolvePane(step.pane);
        await ensureReady(paneId);
        const token = deps.uid();
        const marker = `HERDR_FACTORY_SETUP_DONE_${token}`;
        await deps.herdr.paneRun(paneId, wrapSetup(step.command, token));
        if (step.blocking) {
          const line = await deps.herdr.waitOutput(paneId, marker, SETUP_TIMEOUT_MS);
          const code = line ? Number(line.trim().split(/\s+/).pop()) : NaN;
          if (Number.isFinite(code) && code !== 0) deps.log("warn", `layout "${layout.id}": setup command exited ${code} in ${paneId}`);
        }
        break;
      }
      case "run": {
        const paneId = resolvePane(step.pane);
        await ensureReady(paneId);
        await deps.herdr.paneRun(paneId, step.command);
        break;
      }
    }
  }
}
