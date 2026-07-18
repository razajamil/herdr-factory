// Turns a repo config.yml (as a live `yaml` Document) into a flat, ordered list of field
// descriptors that config-editor.ts renders as browsable rows. The config tab shows these across
// four numbered panels (see `ConfigSection`): the singletons (repo/limits/evidence), work_sources,
// layouts, and belts — each built by passing the matching `section` here. Array-of-object items
// (work_sources, belts, steps) are emitted as collapsible `group` rows — collapsed by default,
// labeled by their name/id — and their inner fields are only emitted when expanded. Collapse state
// is tracked by the caller in a WeakSet keyed by the item's yaml node (stable across rebuilds +
// index shifts).
//
// Structural edits (add/remove, type switch) mutate the Document surgically — setIn/addIn/deleteIn
// (+ createNode for new nodes) preserve comments on untouched nodes — then call `rebuild`.
import type { Document } from "yaml";
import { SOURCE_DESCRIPTORS, descriptorFor } from "../sources/registry.ts";
import { STEP_DESCRIPTORS } from "../steps/registry.ts";
import type { SourceType } from "../types.ts";
import type { ConfirmFn } from "./types.ts";

export type Path = (string | number)[];

/** Which slice of a repo config a `buildDescriptors` call emits — one per numbered config panel.
 *  `general` = the singleton blocks (repo, limits, evidence); `work_sources`, `layouts`, and `belt`
 *  = the three array sections that were split out so a dense config stays scannable. */
export type ConfigSection = "general" | "work_sources" | "layouts" | "belt";

export type FieldDesc =
  | { kind: "header"; label: string; level: 1 | 2; indent?: number }
  | { kind: "group"; label: string; node: object; expanded: boolean; indent?: number; moveUp?: () => void; moveDown?: () => void }
  // `clearable`: blanking the field DELETES its key (vs. the default, which skips empties so a
  // required field can't be accidentally lost) — the only way to unset an optional scalar in place.
  | { kind: "text"; label: string; path?: Path; env?: string; masked?: boolean; placeholder?: string; numeric?: boolean; clearable?: boolean; indent?: number }
  | { kind: "enum"; label: string; value: string; choices: string[]; apply: (next: string) => void; indent?: number }
  | { kind: "bool"; label: string; value: boolean; apply: (next: boolean) => void; indent?: number }
  | { kind: "ref"; label: string; value: string; choices: string[]; apply: (next: string) => void; indent?: number }
  | { kind: "action"; label: string; run: () => void; indent?: number };

// ── defaults for newly-created nodes ────────────────────────────────────────────────────────────
// Source-type blocks come from the registry (descriptor.tui.defaultBlock); belts stay local.
const SOURCE_TYPE_CHOICES = SOURCE_DESCRIPTORS.map((d) => d.type);
// Belt steps reference a registered step primitive by `type` (mirrors the source-type choices above,
// registry-driven so a new/plugin primitive appears without editing this file).
const STEP_TYPE_CHOICES = STEP_DESCRIPTORS.map((d) => d.name);
// A layout pane's split direction (mirrors PaneSplitSchema in config.ts). vertical/right → a pane to
// the RIGHT of the previous one; horizontal/down → BELOW it. Ignored on a tab's first pane.
const SPLIT_CHOICES = ["vertical", "horizontal", "right", "down"];
const sourceNode = (type: SourceType, name?: unknown, pollInterval?: unknown) => ({
  type,
  ...(name != null ? { name } : {}),
  ...(pollInterval != null ? { poll_interval_seconds: pollInterval } : {}),
  [type]: descriptorFor(type).tui.defaultBlock(),
});
// A newly-added step defaults to the generic `custom` primitive (its prompt_file is the whole body);
// the `type` field is editable to any registered primitive. A brand-new belt starts with one valid
// `work` step (work needs no prompt_file), which the user extends.
const defaultStep = (name: string) => ({ type: "custom", name, prompt_file: "", prompt_file_source: "config" });

// Per-step budgets moved onto the step primitives (clean break), so the four *_budget_seconds limits
// are gone from the schema and this list.
const LIMITS: [string, string][] = [
  ["max_active_workspaces", "3"],
  ["attention_renotify_seconds", "3600"],
  ["stall_seconds", "2700"],
  ["max_bounces", "6"],
  ["max_capture_attempts", "5"],
  ["step_budget_seconds", "3600"],
  ["tick_interval_seconds", "60"],
  ["source_poll_interval_seconds", "= tick_interval_seconds"],
  ["reconcile_concurrency", "8"],
  ["max_claims_per_tick", "10"],
  ["layout_wait_seconds", "600"],
];

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function buildDescriptors(draft: Document, rebuild: () => void, confirm: ConfirmFn, expanded: WeakSet<object>, section: ConfigSection): FieldDesc[] {
  const cfg = (draft.toJS() ?? {}) as Record<string, any>;
  const d: FieldDesc[] = [];
  const node = (path: Path) => draft.getIn(path) as object; // stable yaml node — the collapse key
  const isOpen = (path: Path) => expanded.has(node(path));
  const open = (path: Path) => { const n = node(path); if (n) expanded.add(n); };
  // Reorder an array item by swapping the parent YAMLSeq's item nodes (preserves comments + node
  // identity, so collapse state follows the moved item).
  const swap = (arrayPath: Path, i: number, j: number) => {
    const seq = draft.getIn(arrayPath) as { items?: unknown[] } | undefined;
    if (!seq?.items) return;
    const it = seq.items;
    [it[i], it[j]] = [it[j], it[i]];
    rebuild();
  };
  const mover = (arrayPath: Path, i: number, count: number) => ({
    moveUp: i > 0 ? () => swap(arrayPath, i, i - 1) : undefined,
    moveDown: i < count - 1 ? () => swap(arrayPath, i, i + 1) : undefined,
  });
  // Append to a possibly-absent array (layouts / a belt's layout_matching are optional, so the YAML
  // key may not exist yet). addIn needs an existing collection; setIn creates the sequence first.
  const addToArray = (arrayPath: Path, item: object) => {
    if (draft.getIn(arrayPath) == null) draft.setIn(arrayPath, draft.createNode([item]));
    else draft.addIn(arrayPath, draft.createNode(item));
  };

  // Source names are needed by both the work_sources section (dedup on add) and the belt section
  // (the `source` ref choices + which pickup label a belt shows), so compute them regardless.
  const sources: any[] = Array.isArray(cfg.work_sources) ? cfg.work_sources : [];
  const sourceNames = sources.map((s, i) => String(s?.name ?? s?.type ?? `source${i}`));

  // ── general: the singleton blocks (repo / limits / evidence) that share panel [2] ──
  if (section === "general") {
    // repo (a singleton object — always shown, not collapsible)
    d.push({ kind: "header", label: "repo", level: 1 });
    d.push({ kind: "text", label: "path", path: ["repo", "path"], placeholder: "~/dev/my-repo", indent: 1 });
    d.push({ kind: "text", label: "base_ref", path: ["repo", "base_ref"], placeholder: "origin/main", indent: 1 });
    d.push({ kind: "text", label: "github", path: ["repo", "github"], placeholder: "owner/name (optional)", indent: 1 });

    // limits
    d.push({ kind: "header", label: "limits", level: 1 });
    for (const [k, ph] of LIMITS) d.push({ kind: "text", label: k, path: ["limits", k], placeholder: ph, numeric: true, indent: 1 });

    // evidence (optional top-level block — where the evidence step publishes captured media).
    // Non-secret pointers only; AWS creds come from the ambient AWS credential chain (no secret rows
    // here). Modelled as an add/remove optional block (like a work source): when absent, an "add"
    // action creates it; when present, its fields + a "remove" action are shown — so a block the user
    // no longer wants can always be cleared (flushInputs never deletes keys, so a plain text field for
    // an optional block would otherwise be unclearable). bucket/region/cloudfront_domain are required
    // together once the block exists.
    d.push({ kind: "header", label: "evidence (optional — S3 + CloudFront upload)", level: 1 });
    if (cfg.evidence == null) {
      d.push({ kind: "action", label: "+ add evidence upload config", indent: 1, run: () => { draft.setIn(["evidence"], draft.createNode({ bucket: "", region: "", cloudfront_domain: "" })); rebuild(); } });
    } else {
      d.push({ kind: "text", label: "bucket", path: ["evidence", "bucket"], placeholder: "my-evidence-bucket", indent: 1 });
      d.push({ kind: "text", label: "region", path: ["evidence", "region"], placeholder: "us-east-1", indent: 1 });
      d.push({ kind: "text", label: "cloudfront_domain", path: ["evidence", "cloudfront_domain"], placeholder: "d123abc.cloudfront.net", indent: 1 });
      d.push({ kind: "text", label: "github_username", path: ["evidence", "github_username"], placeholder: "(optional; default = gh login)", indent: 1 });
      d.push({ kind: "text", label: "key_prefix", path: ["evidence", "key_prefix"], placeholder: "(optional; after herdr-factory/<user>/)", indent: 1 });
      d.push({ kind: "text", label: "profile", path: ["evidence", "profile"], placeholder: "(optional AWS CLI profile)", indent: 1 });
      d.push({ kind: "action", label: "‹ remove evidence config ›", indent: 1, run: () => { void confirm("Remove the evidence upload config?").then((ok) => { if (ok) { draft.deleteIn(["evidence"]); rebuild(); } }); } });
    }
    return d;
  }

  // ── work_sources (array of objects → collapsible) — panel [3]. The panel border/title labels the
  // section, so no top-level header row here. ──
  if (section === "work_sources") {
    sources.forEach((s, i) => {
      const type = String(s?.type ?? "jira");
      d.push({ kind: "group", label: `${sourceNames[i]} (${type})`, node: node(["work_sources", i]), expanded: isOpen(["work_sources", i]), indent: 0, ...mover(["work_sources"], i, sources.length) });
      if (!isOpen(["work_sources", i])) return;
      d.push({ kind: "text", label: "name", path: ["work_sources", i, "name"], placeholder: type, indent: 1 });
      // Common (type-agnostic) source field: how often to poll THIS source for new work. Optional —
      // clearable back to the repo-wide default (limits.source_poll_interval_seconds, itself the tick).
      d.push({ kind: "text", label: "poll_interval_seconds", path: ["work_sources", i, "poll_interval_seconds"], placeholder: "= source_poll_interval_seconds", numeric: true, clearable: true, indent: 1 });
      d.push({
        kind: "enum",
        label: "type",
        value: type,
        choices: SOURCE_TYPE_CHOICES,
        indent: 1,
        apply: (next) => {
          if (next === type) return;
          const name = draft.getIn(["work_sources", i, "name"]);
          const poll = draft.getIn(["work_sources", i, "poll_interval_seconds"]); // common field survives the type switch
          draft.setIn(["work_sources", i], draft.createNode(sourceNode(next as SourceType, name, poll)));
          open(["work_sources", i]); // keep expanded after switching type
          rebuild();
        },
      });
      // The type block's fields come from the type's descriptor (an unknown type — hand-edited
      // YAML — falls back to no fields; the schema validation on save reports it properly).
      const descriptor = SOURCE_DESCRIPTORS.find((x) => x.type === type);
      for (const f of descriptor?.tui.fields ?? []) {
        const full: Path = ["work_sources", i, ...f.path];
        if (f.choices) {
          // A pick-list field (e.g. auth.method): read the current value, default to enumDefault when
          // unset, and setIn on change (creates intermediate maps like auth:{} as needed).
          const cur = draft.getIn(full);
          const value = cur == null ? (f.enumDefault ?? f.choices[0]!) : String(cur);
          d.push({ kind: "enum", label: f.label, value, choices: [...f.choices], indent: 1, apply: (next) => { if (next !== value) { draft.setIn(full, next); rebuild(); } } });
        } else {
          d.push({ kind: "text", label: f.label, path: full, placeholder: f.placeholder, numeric: f.numeric, indent: 1 });
        }
      }
      d.push({ kind: "action", label: "‹ remove source ›", indent: 1, run: () => { void confirm(`Remove work source "${sourceNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["work_sources", i]); rebuild(); } }); } });
    });
    d.push({
      kind: "action",
      label: "+ add work source",
      indent: 0,
      run: () => {
        const type = SOURCE_TYPE_CHOICES[0]!; // jira first (the registry's canonical order)
        draft.addIn(["work_sources"], draft.createNode({ ...sourceNode(type), name: uniqueName(type, sourceNames) }));
        open(["work_sources", sources.length]);
        rebuild();
      },
    });
    return d;
  }

  // Defined layout ids — needed by BOTH the layouts section (dedup/label) and the belt section
  // (default_layout / layout_matching reference them), so compute regardless of `section`.
  const layouts: any[] = Array.isArray(cfg.layouts) ? cfg.layouts : [];
  const layoutIds = layouts.map((l, i) => String(l?.id ?? `layout${i}`));

  // ── layouts (array of objects → collapsible) — panel [4]. A repo-level library of herdr tab/pane
  // arrangements the factory BUILDS into a worktree on creation; belts point at one via
  // default_layout / layout_matching (in the belt section). Nested two levels deep: layout → tabs →
  // panes. The panel border/title labels the section, so no top-level header row here. ──
  if (section === "layouts") {
    layouts.forEach((l, i) => {
      const tabs: any[] = Array.isArray(l?.tabs) ? l.tabs : [];
      d.push({ kind: "group", label: `${layoutIds[i]} [${tabs.length} tab${tabs.length === 1 ? "" : "s"}]`, node: node(["layouts", i]), expanded: isOpen(["layouts", i]), indent: 0, ...mover(["layouts"], i, layouts.length) });
      if (!isOpen(["layouts", i])) return;
      d.push({ kind: "text", label: "id", path: ["layouts", i, "id"], placeholder: "app-dev", indent: 1 });

      // setup — an OPTIONAL layout-level command run once in the single `setup: true` pane before the
      // rest of the tabs spawn. Modelled as an add/remove block (flushInputs never deletes keys, so a
      // bare optional text field would be unclearable).
      if (l?.setup == null) {
        d.push({ kind: "action", label: "+ add setup command", indent: 1, run: () => { draft.setIn(["layouts", i, "setup"], draft.createNode({ command: "", blocking: false })); rebuild(); } });
      } else {
        d.push({ kind: "text", label: "setup.command", path: ["layouts", i, "setup", "command"], placeholder: "mise run setup", indent: 1 });
        d.push({ kind: "bool", label: "setup.blocking", value: l?.setup?.blocking === true, indent: 1, apply: (next) => { draft.setIn(["layouts", i, "setup", "blocking"], next); rebuild(); } });
        d.push({ kind: "action", label: "‹ remove setup ›", indent: 1, run: () => { draft.deleteIn(["layouts", i, "setup"]); rebuild(); } });
      }

      // tabs[] — each a herdr tab (its `title` is what a step's `tab` matches) holding ≥1 pane.
      const tabTitles = tabs.map((t, j) => String(t?.title ?? `tab${j}`));
      tabs.forEach((t, j) => {
        const panes: any[] = Array.isArray(t?.panes) ? t.panes : [];
        d.push({ kind: "group", label: `${tabTitles[j]} (${panes.length} pane${panes.length === 1 ? "" : "s"})`, node: node(["layouts", i, "tabs", j]), expanded: isOpen(["layouts", i, "tabs", j]), indent: 1, ...mover(["layouts", i, "tabs"], j, tabs.length) });
        if (!isOpen(["layouts", i, "tabs", j])) return;
        d.push({ kind: "text", label: "title", path: ["layouts", i, "tabs", j, "title"], placeholder: "work (a step's `tab` matches this)", clearable: true, indent: 2 });

        // panes[] — each a herdr pane. The `title` is what a step's `pane` matches; an agent pane
        // (command: claude/opencode/…) is the one the step's prompt gets delivered to.
        const paneTitles = panes.map((p, k) => String(p?.title ?? `pane${k}`));
        panes.forEach((p, k) => {
          const base: Path = ["layouts", i, "tabs", j, "panes", k];
          d.push({ kind: "group", label: paneTitles[k]!, node: node(base), expanded: isOpen(base), indent: 2, ...mover(["layouts", i, "tabs", j, "panes"], k, panes.length) });
          if (!isOpen(base)) return;
          d.push({ kind: "text", label: "title", path: [...base, "title"], placeholder: "agent (a step's `pane` matches this)", clearable: true, indent: 3 });
          d.push({ kind: "text", label: "command", path: [...base, "command"], placeholder: "claude", clearable: true, indent: 3 });
          d.push({ kind: "bool", label: "setup", value: p?.setup === true, indent: 3, apply: (next) => { draft.setIn([...base, "setup"], next); rebuild(); } });
          // split — optional; a leading "(unset)" clears it (a tab's first pane ignores split anyway).
          const splitCur = p?.split == null ? "(unset)" : String(p.split);
          d.push({ kind: "enum", label: "split", value: splitCur, choices: ["(unset)", ...SPLIT_CHOICES], indent: 3, apply: (next) => { if (next === "(unset)") draft.deleteIn([...base, "split"]); else draft.setIn([...base, "split"], next); rebuild(); } });
          d.push({ kind: "text", label: "size", path: [...base, "size"], placeholder: '"40%", a 0<n<1 fraction, or cells', clearable: true, indent: 3 });
          d.push({ kind: "action", label: "‹ remove pane ›", indent: 3, run: () => { void confirm(`Remove pane "${paneTitles[k]}"?`).then((ok) => { if (ok) { draft.deleteIn(base); rebuild(); } }); } });
        });
        d.push({ kind: "action", label: "+ add pane", indent: 2, run: () => { draft.addIn(["layouts", i, "tabs", j, "panes"], draft.createNode({ title: uniqueName("pane", paneTitles), command: "" })); open(["layouts", i, "tabs", j, "panes", panes.length]); rebuild(); } });
        d.push({ kind: "action", label: "‹ remove tab ›", indent: 2, run: () => { void confirm(`Remove tab "${tabTitles[j]}"?`).then((ok) => { if (ok) { draft.deleteIn(["layouts", i, "tabs", j]); rebuild(); } }); } });
      });
      d.push({ kind: "action", label: "+ add tab", indent: 1, run: () => { draft.addIn(["layouts", i, "tabs"], draft.createNode({ title: uniqueName("tab", tabTitles), panes: [{ title: "agent", command: "claude" }] })); open(["layouts", i, "tabs", tabs.length]); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove layout ›", indent: 1, run: () => { void confirm(`Remove layout "${layoutIds[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["layouts", i]); rebuild(); } }); } });
    });
    d.push({
      kind: "action",
      label: "+ add layout",
      indent: 0,
      run: () => {
        addToArray(["layouts"], { id: uniqueName("layout", layoutIds), tabs: [{ title: "work", panes: [{ title: "agent", command: "claude" }] }] });
        open(["layouts", layouts.length]);
        rebuild();
      },
    });
    return d;
  }

  // ── belts (array of objects → collapsible) — panel [5]. The panel border/title labels the
  // section, so no top-level header row here. ──
  const belts: any[] = Array.isArray(cfg.belt) ? cfg.belt : [];
  const beltNames = belts.map((b, i) => String(b?.name ?? `belt${i}`));
  // Which pickup-label noun (if any) each source name uses — drives whether a belt on it shows a
  // `label` field. Falls back to no-label for hand-edited/unknown source types.
  const sourceTypeByName = new Map(sources.map((s, i) => [sourceNames[i]!, String(s?.type ?? "")]));
  belts.forEach((b, i) => {
    const steps: any[] = Array.isArray(b?.steps) ? b.steps : [];
    // Group label shows the step pipeline (there is no belt_type anymore — the lifecycle is derived
    // from what the steps produce; a belt with a `pr` step gets the terminal PR watch).
    const pipeline = steps.map((s) => String(s?.type ?? "?")).join("→") || "empty";
    d.push({ kind: "group", label: `${beltNames[i]} [${pipeline}]`, node: node(["belt", i]), expanded: isOpen(["belt", i]), indent: 0, ...mover(["belt"], i, belts.length) });
    if (!isOpen(["belt", i])) return;
    d.push({ kind: "text", label: "name", path: ["belt", i, "name"], placeholder: "my_belt", indent: 1 });
    d.push({ kind: "ref", label: "source", value: String(b?.source ?? ""), choices: sourceNames.length ? sourceNames : [""], indent: 1, apply: (next) => { draft.setIn(["belt", i, "source"], next); rebuild(); } });
    d.push({ kind: "text", label: "priority", path: ["belt", i, "priority"], placeholder: "100", numeric: true, indent: 1 });
    // The per-belt pickup label — shown only for a label-driven source (jira/github_issues), where
    // it's REQUIRED; a source with no label concept (local_markdown) has none, so it's hidden.
    const pickup = SOURCE_DESCRIPTORS.find((x) => x.type === sourceTypeByName.get(String(b?.source ?? "")))?.pickupLabel;
    if (pickup) d.push({ kind: "text", label: "label", path: ["belt", i, "label"], placeholder: `${pickup.noun} — required (no default)`, indent: 1 });
    d.push({ kind: "text", label: "workspace_name", path: ["belt", i, "workspace_name"], placeholder: "{{work_id}}-{{work_slug}}", clearable: true, indent: 1 });
    d.push({ kind: "text", label: "match", path: ["belt", i, "match"], placeholder: "match.ts (optional)", clearable: true, indent: 1 });

    // Layout selection — which `layouts:` entry (section 4) the factory builds into this belt's
    // worktrees. default_layout is the fallback; a layout_matching rule picks a different one per
    // branch (first matching glob wins). Both reference a layout id; "(unset)" clears default_layout.
    const dlCur = b?.default_layout == null ? "(unset)" : String(b.default_layout);
    d.push({ kind: "enum", label: "default_layout", value: dlCur, choices: ["(unset)", ...layoutIds], indent: 1, apply: (next) => { if (next === "(unset)") draft.deleteIn(["belt", i, "default_layout"]); else draft.setIn(["belt", i, "default_layout"], next); rebuild(); } });
    const rules: any[] = Array.isArray(b?.layout_matching) ? b.layout_matching : [];
    rules.forEach((r, k) => {
      d.push({ kind: "group", label: `match ${String(r?.worktree_pattern ?? "?")} → ${String(r?.layout ?? "?")}`, node: node(["belt", i, "layout_matching", k]), expanded: isOpen(["belt", i, "layout_matching", k]), indent: 1, ...mover(["belt", i, "layout_matching"], k, rules.length) });
      if (!isOpen(["belt", i, "layout_matching", k])) return;
      d.push({ kind: "text", label: "worktree_pattern", path: ["belt", i, "layout_matching", k, "worktree_pattern"], placeholder: "hotfix/*", indent: 2 });
      d.push({ kind: "enum", label: "layout", value: String(r?.layout ?? (layoutIds[0] ?? "")), choices: layoutIds.length ? layoutIds : [""], indent: 2, apply: (next) => { draft.setIn(["belt", i, "layout_matching", k, "layout"], next); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove rule ›", indent: 2, run: () => { void confirm("Remove this layout_matching rule?").then((ok) => { if (ok) { draft.deleteIn(["belt", i, "layout_matching", k]); rebuild(); } }); } });
    });
    d.push({ kind: "action", label: "+ add layout_matching rule", indent: 1, run: () => { addToArray(["belt", i, "layout_matching"], { worktree_pattern: "", layout: layoutIds[0] ?? "" }); open(["belt", i, "layout_matching", rules.length]); rebuild(); } });

    // steps[] — an ordered list of step-primitive references. `type` picks the primitive; a `custom`
    // step's prompt_file is its whole body (required), an engine-prompted step's is an optional augment.
    const stepNames = steps.map((s, j) => String(s?.name ?? s?.type ?? `step${j}`));
    steps.forEach((st, j) => {
      const stType = String(st?.type ?? "custom");
      d.push({ kind: "group", label: `${stepNames[j]} (${stType})`, node: node(["belt", i, "steps", j]), expanded: isOpen(["belt", i, "steps", j]), indent: 1, ...mover(["belt", i, "steps"], j, steps.length) });
      if (!isOpen(["belt", i, "steps", j])) return;
      d.push({ kind: "enum", label: "type", value: stType, choices: STEP_TYPE_CHOICES, indent: 2, apply: (next) => { if (next !== stType) { draft.setIn(["belt", i, "steps", j, "type"], next); rebuild(); } } });
      d.push({ kind: "text", label: "name", path: ["belt", i, "steps", j, "name"], placeholder: `${stType} (defaults to type)`, indent: 2 });
      // evidence runs ONLY when tab+pane target an existing layout agent; without them it's skipped.
      const layoutHint = stType === "evidence" ? "(evidence runs only if tab+pane set; else skipped)" : "(optional; set with the other)";
      d.push({ kind: "text", label: "tab", path: ["belt", i, "steps", j, "tab"], placeholder: layoutHint, clearable: true, indent: 2 });
      d.push({ kind: "text", label: "pane", path: ["belt", i, "steps", j, "pane"], placeholder: layoutHint, clearable: true, indent: 2 });
      d.push({ kind: "text", label: "prompt_file", path: ["belt", i, "steps", j, "prompt_file"], placeholder: stType === "custom" ? "prompts/step.md (required)" : "(optional augment)", clearable: true, indent: 2 });
      d.push(optionalSource(["belt", i, "steps", j, "prompt_file_source"], st?.prompt_file_source, draft, rebuild, 2));
      d.push({ kind: "text", label: "budget_seconds", path: ["belt", i, "steps", j, "budget_seconds"], placeholder: "(optional; default per type)", numeric: true, clearable: true, indent: 2 });
      d.push({ kind: "bool", label: "heartbeat", value: st?.heartbeat === true, indent: 2, apply: (next) => { draft.setIn(["belt", i, "steps", j, "heartbeat"], next); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove step ›", indent: 2, run: () => { void confirm(`Remove step "${stepNames[j]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i, "steps", j]); rebuild(); } }); } });
    });
    d.push({ kind: "action", label: "+ add step", indent: 1, run: () => { draft.addIn(["belt", i, "steps"], draft.createNode(defaultStep(uniqueName("step", stepNames)))); open(["belt", i, "steps", steps.length]); rebuild(); } });
    d.push({ kind: "action", label: "‹ remove belt ›", indent: 1, run: () => { void confirm(`Remove belt "${beltNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i]); rebuild(); } }); } });
  });
  d.push({
    kind: "action",
    label: "+ add belt",
    indent: 0,
    run: () => {
      draft.addIn(["belt"], draft.createNode({ name: uniqueName("belt", beltNames), source: sourceNames[0] ?? "", priority: 100, steps: [{ type: "work", name: "work" }] }));
      open(["belt", belts.length]);
      rebuild();
    },
  });

  return d;
}

/** An optional enum (e.g. a w2pr agent's prompt_file_source): a `(unset)` choice deletes the key. */
function optionalSource(path: Path, current: unknown, draft: Document, rebuild: () => void, indent: number): FieldDesc {
  return {
    kind: "enum",
    label: "prompt_file_source",
    value: current == null ? "(unset)" : String(current),
    choices: ["(unset)", "config", "repo"],
    indent,
    apply: (next) => {
      if (next === "(unset)") draft.deleteIn(path);
      else draft.setIn(path, next);
      rebuild();
    },
  };
}
