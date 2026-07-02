// Turns a repo config.yml (as a live `yaml` Document) into a flat, ordered list of field
// descriptors that config-editor.ts renders as browsable rows. Array-of-object items (work_sources,
// belts, steps) are emitted as collapsible `group` rows — collapsed by default, labeled by their
// name/id — and their inner fields are only emitted when expanded. Collapse state is tracked by the
// caller in a WeakSet keyed by the item's yaml node (stable across rebuilds + index shifts).
//
// Structural edits (add/remove, type switch) mutate the Document surgically — setIn/addIn/deleteIn
// (+ createNode for new nodes) preserve comments on untouched nodes — then call `rebuild`.
import type { Document } from "yaml";

export type Path = (string | number)[];
export type ConfirmFn = (message: string) => Promise<boolean>;

export type FieldDesc =
  | { kind: "header"; label: string; level: 1 | 2; indent?: number }
  | { kind: "group"; label: string; node: object; expanded: boolean; indent?: number }
  | { kind: "text"; label: string; path: Path; placeholder?: string; numeric?: boolean; indent?: number }
  | { kind: "enum"; label: string; value: string; choices: string[]; apply: (next: string) => void; indent?: number }
  | { kind: "bool"; label: string; value: boolean; apply: (next: boolean) => void; indent?: number }
  | { kind: "ref"; label: string; value: string; choices: string[]; apply: (next: string) => void; indent?: number }
  | { kind: "action"; label: string; run: () => void; indent?: number };

// ── defaults for newly-created nodes ────────────────────────────────────────────────────────────
const jiraBlock = () => ({
  base_url: "",
  project: "",
  board: "",
  label: "agent",
  status: { todo: "To Do", in_development: "In Progress", review: "In Review" },
});
const localMarkdownBlock = () => ({ folder: "" });
const defaultStep = (name: string) => ({ name, prompt_file: "", prompt_file_source: "config" });
const prAgents = () => ({ fix: {}, review: {}, pr: {} }); // empty agent blocks are valid by default

const LIMITS: [string, string][] = [
  ["max_active", "3"],
  ["watch_hours", "7"],
  ["develop_budget_seconds", "5400"],
  ["stall_seconds", "2700"],
  ["review_budget_seconds", "1800"],
  ["pr_budget_seconds", "3600"],
  ["step_budget_seconds", "3600"],
  ["tick_interval_seconds", "60"],
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
    d.push({ kind: "group", label: `${sourceNames[i]} (${type})`, node: node(["work_sources", i]), expanded: isOpen(["work_sources", i]), indent: 1 });
    if (!isOpen(["work_sources", i])) return;
    d.push({ kind: "text", label: "name", path: ["work_sources", i, "name"], placeholder: type, indent: 2 });
    d.push({
      kind: "enum",
      label: "type",
      value: type,
      choices: ["jira", "local_markdown"],
      indent: 2,
      apply: (next) => {
        if (next === type) return;
        const name = draft.getIn(["work_sources", i, "name"]);
        const built =
          next === "jira"
            ? { type: "jira", ...(name != null ? { name } : {}), jira: jiraBlock() }
            : { type: "local_markdown", ...(name != null ? { name } : {}), local_markdown: localMarkdownBlock() };
        draft.setIn(["work_sources", i], draft.createNode(built));
        open(["work_sources", i]); // keep expanded after switching type
        rebuild();
      },
    });
    if (type === "jira") {
      d.push({ kind: "text", label: "jira.base_url", path: ["work_sources", i, "jira", "base_url"], placeholder: "https://org.atlassian.net", indent: 2 });
      d.push({ kind: "text", label: "jira.project", path: ["work_sources", i, "jira", "project"], placeholder: "PROJ", indent: 2 });
      d.push({ kind: "text", label: "jira.board", path: ["work_sources", i, "jira", "board"], placeholder: "123", indent: 2 });
      d.push({ kind: "text", label: "jira.label", path: ["work_sources", i, "jira", "label"], placeholder: "agent", indent: 2 });
      d.push({ kind: "text", label: "status.todo", path: ["work_sources", i, "jira", "status", "todo"], placeholder: "To Do", indent: 2 });
      d.push({ kind: "text", label: "status.in_development", path: ["work_sources", i, "jira", "status", "in_development"], placeholder: "In Progress", indent: 2 });
      d.push({ kind: "text", label: "status.review", path: ["work_sources", i, "jira", "status", "review"], placeholder: "In Review", indent: 2 });
    } else {
      d.push({ kind: "text", label: "folder", path: ["work_sources", i, "local_markdown", "folder"], placeholder: "~/dev/work-items", indent: 2 });
    }
    d.push({ kind: "action", label: "‹ remove source ›", indent: 2, run: () => { void confirm(`Remove work source "${sourceNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["work_sources", i]); rebuild(); } }); } });
  });
  d.push({
    kind: "action",
    label: "+ add work source",
    indent: 1,
    run: () => {
      draft.addIn(["work_sources"], draft.createNode({ type: "jira", name: uniqueName("jira", sourceNames), jira: jiraBlock() }));
      open(["work_sources", sources.length]);
      rebuild();
    },
  });

  // ── belts (array of objects → collapsible) ──
  d.push({ kind: "header", label: "belt", level: 1 });
  const belts: any[] = Array.isArray(cfg.belt) ? cfg.belt : [];
  const beltNames = belts.map((b, i) => String(b?.name ?? `belt${i}`));
  belts.forEach((b, i) => {
    const beltType = String(b?.belt_type ?? "custom");
    d.push({ kind: "group", label: `${beltNames[i]} [${beltType}]`, node: node(["belt", i]), expanded: isOpen(["belt", i]), indent: 1 });
    if (!isOpen(["belt", i])) return;
    d.push({ kind: "text", label: "name", path: ["belt", i, "name"], placeholder: "my_belt", indent: 2 });
    d.push({
      kind: "enum",
      label: "belt_type",
      value: beltType,
      choices: ["work_to_pull_request", "custom"],
      indent: 2,
      apply: (next) => {
        if (next === beltType) return;
        const base: Record<string, unknown> = {
          belt_type: next,
          name: b?.name ?? uniqueName("belt", beltNames),
          source: b?.source ?? sourceNames[0] ?? "",
          priority: b?.priority ?? 100,
        };
        if (b?.workspace_name != null) base.workspace_name = b.workspace_name;
        if (b?.match != null) base.match = b.match;
        const built = next === "work_to_pull_request" ? { ...base, agents: prAgents() } : { ...base, steps: [defaultStep("step")] };
        draft.setIn(["belt", i], draft.createNode(built));
        open(["belt", i]);
        rebuild();
      },
    });
    d.push({ kind: "ref", label: "source", value: String(b?.source ?? ""), choices: sourceNames.length ? sourceNames : [""], indent: 2, apply: (next) => { draft.setIn(["belt", i, "source"], next); rebuild(); } });
    d.push({ kind: "text", label: "priority", path: ["belt", i, "priority"], placeholder: "100", numeric: true, indent: 2 });
    d.push({ kind: "text", label: "workspace_name", path: ["belt", i, "workspace_name"], placeholder: "{{work_id}}-{{work_slug}}", indent: 2 });
    d.push({ kind: "text", label: "match", path: ["belt", i, "match"], placeholder: "match.ts (optional)", indent: 2 });

    if (beltType === "work_to_pull_request") {
      for (const step of ["fix", "review", "pr"] as const) {
        d.push({ kind: "header", label: `agents.${step}`, level: 2, indent: 2 });
        d.push({ kind: "text", label: "tab", path: ["belt", i, "agents", step, "tab"], placeholder: "(optional; set with pane)", indent: 3 });
        d.push({ kind: "text", label: "pane", path: ["belt", i, "agents", step, "pane"], placeholder: "(optional; set with tab)", indent: 3 });
        d.push({ kind: "text", label: "prompt_file", path: ["belt", i, "agents", step, "prompt_file"], placeholder: "(optional)", indent: 3 });
        d.push(optionalSource(["belt", i, "agents", step, "prompt_file_source"], b?.agents?.[step]?.prompt_file_source, draft, rebuild, 3));
      }
    } else {
      const steps: any[] = Array.isArray(b?.steps) ? b.steps : [];
      const stepNames = steps.map((s, j) => String(s?.name ?? `step${j}`));
      steps.forEach((st, j) => {
        d.push({ kind: "group", label: stepNames[j]!, node: node(["belt", i, "steps", j]), expanded: isOpen(["belt", i, "steps", j]), indent: 2 });
        if (!isOpen(["belt", i, "steps", j])) return;
        d.push({ kind: "text", label: "name", path: ["belt", i, "steps", j, "name"], placeholder: "research", indent: 3 });
        d.push({ kind: "text", label: "prompt_file", path: ["belt", i, "steps", j, "prompt_file"], placeholder: "prompts/step.md", indent: 3 });
        d.push({ kind: "enum", label: "prompt_file_source", value: String(st?.prompt_file_source ?? "config"), choices: ["config", "repo"], indent: 3, apply: (next) => { draft.setIn(["belt", i, "steps", j, "prompt_file_source"], next); rebuild(); } });
        d.push({ kind: "text", label: "budget_seconds", path: ["belt", i, "steps", j, "budget_seconds"], placeholder: "(optional)", numeric: true, indent: 3 });
        d.push({ kind: "bool", label: "heartbeat", value: st?.heartbeat === true, indent: 3, apply: (next) => { draft.setIn(["belt", i, "steps", j, "heartbeat"], next); rebuild(); } });
        d.push({ kind: "text", label: "tab", path: ["belt", i, "steps", j, "tab"], placeholder: "(optional; set with pane)", indent: 3 });
        d.push({ kind: "text", label: "pane", path: ["belt", i, "steps", j, "pane"], placeholder: "(optional; set with tab)", indent: 3 });
        d.push({ kind: "action", label: "‹ remove step ›", indent: 3, run: () => { void confirm(`Remove step "${stepNames[j]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i, "steps", j]); rebuild(); } }); } });
      });
      d.push({ kind: "action", label: "+ add step", indent: 2, run: () => { draft.addIn(["belt", i, "steps"], draft.createNode(defaultStep(uniqueName("step", stepNames)))); open(["belt", i, "steps", steps.length]); rebuild(); } });
    }
    d.push({ kind: "action", label: "‹ remove belt ›", indent: 2, run: () => { void confirm(`Remove belt "${beltNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i]); rebuild(); } }); } });
  });
  d.push({
    kind: "action",
    label: "+ add belt",
    indent: 1,
    run: () => {
      draft.addIn(["belt"], draft.createNode({ belt_type: "custom", name: uniqueName("belt", beltNames), source: sourceNames[0] ?? "", priority: 100, steps: [defaultStep("step")] }));
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
