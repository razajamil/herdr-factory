// Turns a repo config.yml (as a live `yaml` Document) into a flat, ordered list of field
// descriptors that config-editor.ts renders as browsable rows. Array-of-object items (work_sources,
// belts, steps) are emitted as collapsible `group` rows — collapsed by default, labeled by their
// name/id — and their inner fields are only emitted when expanded. Collapse state is tracked by the
// caller in a WeakSet keyed by the item's yaml node (stable across rebuilds + index shifts).
//
// Structural edits (add/remove, type switch) mutate the Document surgically — setIn/addIn/deleteIn
// (+ createNode for new nodes) preserve comments on untouched nodes — then call `rebuild`.
import type { Document } from "yaml";
import { SOURCE_DESCRIPTORS, descriptorFor } from "../sources/registry.ts";
import { STEP_DESCRIPTORS } from "../steps/registry.ts";
import type { SourceType } from "../types.ts";
import type { ConfirmFn } from "./types.ts";

export type Path = (string | number)[];

export type FieldDesc =
  | { kind: "header"; label: string; level: 1 | 2; indent?: number }
  | { kind: "group"; label: string; node: object; expanded: boolean; indent?: number; moveUp?: () => void; moveDown?: () => void }
  | { kind: "text"; label: string; path?: Path; env?: string; masked?: boolean; placeholder?: string; numeric?: boolean; indent?: number }
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
const sourceNode = (type: SourceType, name?: unknown) => ({
  type,
  ...(name != null ? { name } : {}),
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

export function buildDescriptors(draft: Document, rebuild: () => void, confirm: ConfirmFn, expanded: WeakSet<object>): FieldDesc[] {
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

  // ── repo (a singleton object — always shown, not collapsible) ──
  d.push({ kind: "header", label: "repo", level: 1 });
  d.push({ kind: "text", label: "path", path: ["repo", "path"], placeholder: "~/dev/my-repo", indent: 1 });
  d.push({ kind: "text", label: "base_ref", path: ["repo", "base_ref"], placeholder: "origin/main", indent: 1 });
  d.push({ kind: "text", label: "github", path: ["repo", "github"], placeholder: "owner/name (optional)", indent: 1 });

  // ── limits ──
  d.push({ kind: "header", label: "limits", level: 1 });
  for (const [k, ph] of LIMITS) d.push({ kind: "text", label: k, path: ["limits", k], placeholder: ph, numeric: true, indent: 1 });

  // ── work_sources (array of objects → collapsible) ──
  d.push({ kind: "header", label: "work_sources", level: 1 });
  const sources: any[] = Array.isArray(cfg.work_sources) ? cfg.work_sources : [];
  const sourceNames = sources.map((s, i) => String(s?.name ?? s?.type ?? `source${i}`));
  sources.forEach((s, i) => {
    const type = String(s?.type ?? "jira");
    d.push({ kind: "group", label: `${sourceNames[i]} (${type})`, node: node(["work_sources", i]), expanded: isOpen(["work_sources", i]), indent: 1, ...mover(["work_sources"], i, sources.length) });
    if (!isOpen(["work_sources", i])) return;
    d.push({ kind: "text", label: "name", path: ["work_sources", i, "name"], placeholder: type, indent: 2 });
    d.push({
      kind: "enum",
      label: "type",
      value: type,
      choices: SOURCE_TYPE_CHOICES,
      indent: 2,
      apply: (next) => {
        if (next === type) return;
        const name = draft.getIn(["work_sources", i, "name"]);
        draft.setIn(["work_sources", i], draft.createNode(sourceNode(next as SourceType, name)));
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
        d.push({ kind: "enum", label: f.label, value, choices: [...f.choices], indent: 2, apply: (next) => { if (next !== value) { draft.setIn(full, next); rebuild(); } } });
      } else {
        d.push({ kind: "text", label: f.label, path: full, placeholder: f.placeholder, numeric: f.numeric, indent: 2 });
      }
    }
    d.push({ kind: "action", label: "‹ remove source ›", indent: 2, run: () => { void confirm(`Remove work source "${sourceNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["work_sources", i]); rebuild(); } }); } });
  });
  d.push({
    kind: "action",
    label: "+ add work source",
    indent: 1,
    run: () => {
      const type = SOURCE_TYPE_CHOICES[0]!; // jira first (the registry's canonical order)
      draft.addIn(["work_sources"], draft.createNode({ ...sourceNode(type), name: uniqueName(type, sourceNames) }));
      open(["work_sources", sources.length]);
      rebuild();
    },
  });

  // ── belts (array of objects → collapsible) ──
  d.push({ kind: "header", label: "belt", level: 1 });
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
    d.push({ kind: "group", label: `${beltNames[i]} [${pipeline}]`, node: node(["belt", i]), expanded: isOpen(["belt", i]), indent: 1, ...mover(["belt"], i, belts.length) });
    if (!isOpen(["belt", i])) return;
    d.push({ kind: "text", label: "name", path: ["belt", i, "name"], placeholder: "my_belt", indent: 2 });
    d.push({ kind: "ref", label: "source", value: String(b?.source ?? ""), choices: sourceNames.length ? sourceNames : [""], indent: 2, apply: (next) => { draft.setIn(["belt", i, "source"], next); rebuild(); } });
    d.push({ kind: "text", label: "priority", path: ["belt", i, "priority"], placeholder: "100", numeric: true, indent: 2 });
    // The per-belt pickup label — shown only for a label-driven source (jira/github_issues), where
    // it's REQUIRED; a source with no label concept (local_markdown) has none, so it's hidden.
    const pickup = SOURCE_DESCRIPTORS.find((x) => x.type === sourceTypeByName.get(String(b?.source ?? "")))?.pickupLabel;
    if (pickup) d.push({ kind: "text", label: "label", path: ["belt", i, "label"], placeholder: `${pickup.noun} — required (no default)`, indent: 2 });
    d.push({ kind: "text", label: "workspace_name", path: ["belt", i, "workspace_name"], placeholder: "{{work_id}}-{{work_slug}}", indent: 2 });
    d.push({ kind: "text", label: "match", path: ["belt", i, "match"], placeholder: "match.ts (optional)", indent: 2 });

    // steps[] — an ordered list of step-primitive references. `type` picks the primitive; a `custom`
    // step's prompt_file is its whole body (required), an engine-prompted step's is an optional augment.
    const stepNames = steps.map((s, j) => String(s?.name ?? s?.type ?? `step${j}`));
    steps.forEach((st, j) => {
      const stType = String(st?.type ?? "custom");
      d.push({ kind: "group", label: `${stepNames[j]} (${stType})`, node: node(["belt", i, "steps", j]), expanded: isOpen(["belt", i, "steps", j]), indent: 2, ...mover(["belt", i, "steps"], j, steps.length) });
      if (!isOpen(["belt", i, "steps", j])) return;
      d.push({ kind: "enum", label: "type", value: stType, choices: STEP_TYPE_CHOICES, indent: 3, apply: (next) => { if (next !== stType) { draft.setIn(["belt", i, "steps", j, "type"], next); rebuild(); } } });
      d.push({ kind: "text", label: "name", path: ["belt", i, "steps", j, "name"], placeholder: `${stType} (defaults to type)`, indent: 3 });
      // evidence runs ONLY when tab+pane target an existing layout agent; without them it's skipped.
      const layoutHint = stType === "evidence" ? "(evidence runs only if tab+pane set; else skipped)" : "(optional; set with the other)";
      d.push({ kind: "text", label: "tab", path: ["belt", i, "steps", j, "tab"], placeholder: layoutHint, indent: 3 });
      d.push({ kind: "text", label: "pane", path: ["belt", i, "steps", j, "pane"], placeholder: layoutHint, indent: 3 });
      d.push({ kind: "text", label: "prompt_file", path: ["belt", i, "steps", j, "prompt_file"], placeholder: stType === "custom" ? "prompts/step.md (required)" : "(optional augment)", indent: 3 });
      d.push(optionalSource(["belt", i, "steps", j, "prompt_file_source"], st?.prompt_file_source, draft, rebuild, 3));
      d.push({ kind: "text", label: "budget_seconds", path: ["belt", i, "steps", j, "budget_seconds"], placeholder: "(optional; default per type)", numeric: true, indent: 3 });
      d.push({ kind: "bool", label: "heartbeat", value: st?.heartbeat === true, indent: 3, apply: (next) => { draft.setIn(["belt", i, "steps", j, "heartbeat"], next); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove step ›", indent: 3, run: () => { void confirm(`Remove step "${stepNames[j]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i, "steps", j]); rebuild(); } }); } });
    });
    d.push({ kind: "action", label: "+ add step", indent: 2, run: () => { draft.addIn(["belt", i, "steps"], draft.createNode(defaultStep(uniqueName("step", stepNames)))); open(["belt", i, "steps", steps.length]); rebuild(); } });
    d.push({ kind: "action", label: "‹ remove belt ›", indent: 2, run: () => { void confirm(`Remove belt "${beltNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i]); rebuild(); } }); } });
  });
  d.push({
    kind: "action",
    label: "+ add belt",
    indent: 1,
    run: () => {
      draft.addIn(["belt"], draft.createNode({ name: uniqueName("belt", beltNames), source: sourceNames[0] ?? "", priority: 100, steps: [{ type: "work", name: "work" }] }));
      open(["belt", belts.length]);
      rebuild();
    },
  });

  // ── evidence (optional top-level block — where the evidence step publishes captured media) ──
  // Non-secret pointers only; AWS creds come from the ambient AWS credential chain (no secret rows here).
  // Modelled as an add/remove optional block (like a work source): when absent, an "add" action
  // creates it; when present, its fields + a "remove" action are shown — so a block the user no
  // longer wants can always be cleared (flushInputs never deletes keys, so a plain text field for an
  // optional block would otherwise be unclearable). bucket/region/cloudfront_domain are required
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
