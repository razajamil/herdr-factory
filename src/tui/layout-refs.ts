// Layout ⇄ belt reference plumbing for the TUI config editor: which (tab, pane) targets a layout
// actually offers, and rewriting every belt/step reference when one of those names is renamed.
//
// A belt's `default_layout` / `layout_matching[].layout` and a step's `tab` / `pane` are all STRING
// references into the repo-level `layouts:` library, and the loader ALLOCATES steps to panes at load
// (see the layout-pane allocation check in config.ts: a step's target must exist as a labeled
// tab/pane of its belt's `default_layout`). Two consequences the editor leans on:
//   - it can offer a layout's real tabs/panes as pick-lists instead of free text (no more flipping
//     between the layouts panel [4] and the belts panel [5] to recall a pane title), and
//   - it can keep the references in sync when a layout id / tab title / pane title is renamed, so
//     nobody hand-syncs section [5] against section [4] (and no save fails on a dangling target).
// Everything here is a pure read of the draft plus surgical `setIn`s, so it's unit-testable and
// preserves comments on untouched nodes like the rest of the field builder.
import type { Document } from "yaml";

/** A layout's ADDRESSABLE targets: one entry per titled tab, holding that tab's titled panes.
 *  herdr addresses a pane by tab title + pane title, so an untitled tab/pane can't be targeted at
 *  all — mirroring the `layoutPaneTargets` map the loader validates steps against. A tab with no
 *  titled pane is dropped: there is nothing in it to allocate a step to. */
export interface LayoutTarget {
  readonly tab: string;
  readonly panes: readonly string[];
}

/** How a rename propagated. `ambiguous` counts references left ALONE because another layout the same
 *  belt uses also defines the old target, so which one the step meant can't be known. */
export interface RenameOutcome {
  readonly updated: number;
  readonly ambiguous: number;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/** The titled (tab → panes) targets of one `layouts:` entry, in declaration order. Same-titled tabs
 *  merge (herdr would address them by the one label anyway). */
export function layoutTargets(layout: unknown): LayoutTarget[] {
  const tabs = (layout as { tabs?: unknown })?.tabs;
  if (!Array.isArray(tabs)) return [];
  const byTab = new Map<string, string[]>();
  for (const t of tabs) {
    const tab = str((t as { title?: unknown })?.title);
    if (!tab) continue;
    const panes = (Array.isArray((t as { panes?: unknown[] })?.panes) ? (t as { panes: unknown[] }).panes : [])
      .map((p) => str((p as { title?: unknown })?.title))
      .filter((s) => s !== "");
    if (panes.length === 0) continue;
    const seen = byTab.get(tab);
    if (seen) seen.push(...panes.filter((p) => !seen.includes(p)));
    else byTab.set(tab, panes);
  }
  return [...byTab].map(([tab, panes]) => ({ tab, panes }));
}

type Cfg = { belt?: unknown; layouts?: unknown };
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const cfgOf = (draft: Document): Cfg => ((draft.toJS() ?? {}) as Cfg);
const layoutById = (cfg: Cfg, id: string): unknown => arr(cfg.layouts).find((l) => str(l?.id) === id);

/** Every layout id a belt points at: its `default_layout` plus each `layout_matching` rule. */
function referencedLayoutIds(belt: any): string[] {
  const ids: string[] = [];
  if (belt?.default_layout != null) ids.push(str(belt.default_layout));
  for (const r of arr(belt?.layout_matching)) if (r?.layout != null) ids.push(str(r.layout));
  return [...new Set(ids.filter((x) => x !== ""))];
}

/** Does `layoutId` define this (tab, pane) target? A null pane asks only about the tab. */
function definesTarget(cfg: Cfg, layoutId: string, tab: string, pane: string | null): boolean {
  return layoutTargets(layoutById(cfg, layoutId)).some((t) => t.tab === tab && (pane == null || t.panes.includes(pane)));
}

/** Rename a layout id: repoint every belt that selects it (`default_layout` + `layout_matching`).
 *  Layout ids are unique (the loader rejects duplicates), so there is nothing ambiguous here. */
export function renameLayoutId(draft: Document, from: string, to: string): RenameOutcome {
  let updated = 0;
  arr(cfgOf(draft).belt).forEach((b, i) => {
    if (str(b?.default_layout) === from) {
      draft.setIn(["belt", i, "default_layout"], to);
      updated++;
    }
    arr(b?.layout_matching).forEach((r, j) => {
      if (str(r?.layout) === from) {
        draft.setIn(["belt", i, "layout_matching", j, "layout"], to);
        updated++;
      }
    });
  });
  return { updated, ambiguous: 0 };
}

/** Repoint the step refs of every belt that uses `layoutId`. `hit` selects the steps this rename
 *  touches; `oldTarget` is the (tab, pane) they currently name — if ANOTHER layout the same belt
 *  references also defines that target, the step's intent is ambiguous and it's left untouched
 *  (`layout_matching` layouts are exempt from the loader's allocation check, so a step legitimately
 *  may be aimed at one of them). */
function rewriteStepRefs(
  draft: Document,
  layoutId: string,
  hit: (step: any) => boolean,
  oldTarget: (step: any) => { tab: string; pane: string | null },
  write: (path: (string | number)[]) => void,
): RenameOutcome {
  const cfg = cfgOf(draft);
  let updated = 0;
  let ambiguous = 0;
  arr(cfg.belt).forEach((b, i) => {
    const refs = referencedLayoutIds(b);
    if (!refs.includes(layoutId)) return;
    const others = refs.filter((id) => id !== layoutId);
    arr(b?.steps).forEach((s, j) => {
      if (!hit(s)) return;
      const { tab, pane } = oldTarget(s);
      if (others.some((id) => definesTarget(cfg, id, tab, pane))) {
        ambiguous++;
        return;
      }
      write(["belt", i, "steps", j]);
      updated++;
    });
  });
  return { updated, ambiguous };
}

/** Rename a tab title inside `layoutId`: repoint the `tab` of every step allocated to it. */
export function renameTabTitle(draft: Document, layoutId: string, from: string, to: string): RenameOutcome {
  return rewriteStepRefs(
    draft,
    layoutId,
    (s) => str(s?.tab) === from,
    (s) => ({ tab: from, pane: s?.pane == null ? null : str(s.pane) }),
    (stepPath) => draft.setIn([...stepPath, "tab"], to),
  );
}

/** Rename a pane title inside `layoutId`'s `tab`: repoint the `pane` of every step aimed at it. */
export function renamePaneTitle(draft: Document, layoutId: string, tab: string, from: string, to: string): RenameOutcome {
  return rewriteStepRefs(
    draft,
    layoutId,
    (s) => str(s?.tab) === tab && str(s?.pane) === from,
    () => ({ tab, pane: from }),
    (stepPath) => draft.setIn([...stepPath, "pane"], to),
  );
}

/** The status line a propagated rename reports, or null when nothing referenced the old name. */
export function renameSummary(what: string, from: string, to: string, o: RenameOutcome): string | null {
  if (o.updated === 0 && o.ambiguous === 0) return null;
  const plural = (n: number) => (n === 1 ? "" : "s");
  const parts = [`${what} "${from}" → "${to}": repointed ${o.updated} reference${plural(o.updated)}`];
  if (o.ambiguous > 0) parts.push(`${o.ambiguous} left alone (another layout the belt uses defines it too)`);
  return parts.join(" · ");
}
