// Config tab — two numbered sections: [1] a repo list, [2] a guided editor for the selected repo's
// config.yml. Navigation follows the shell's lazygit model: number keys jump sections, arrows move
// within one, Esc pops to the top level. The editor form has a browse/edit distinction: browsing
// highlights a field (↑/↓ to move, ↵ to edit); editing focuses the field's input (type freely, ↵ =
// next field). v1 edits the scalar knobs (repo block + all limits); work_sources and belts are
// shown read-only. Saves round-trip through the `yaml` Document API (comments + the schema modeline
// preserved) and validate against RepoConfigSchema before writing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent, Renderable } from "@opentui/core";
import { parseDocument } from "yaml";
import { RepoConfigSchema, listConfiguredRepos, repoConfigDir } from "../config.ts";
import { postReload } from "./api.ts";
import { BORDER, theme } from "./theme.ts";
import type { TabView } from "./types.ts";

interface FieldDef {
  path: (string | number)[];
  label: string;
  kind: "string" | "number";
  placeholder: string;
}

// The scalar fields v1 edits. Placeholders show the engine default (see the limits schema in
// config.ts) or an example, so an unset field reads as "unset → default" rather than blank.
const FIELDS: FieldDef[] = [
  { path: ["repo", "path"], label: "repo.path", kind: "string", placeholder: "~/dev/my-repo" },
  { path: ["repo", "base_ref"], label: "repo.base_ref", kind: "string", placeholder: "origin/main" },
  { path: ["repo", "github"], label: "repo.github", kind: "string", placeholder: "owner/name (optional)" },
  { path: ["limits", "max_active"], label: "limits.max_active", kind: "number", placeholder: "3" },
  { path: ["limits", "watch_hours"], label: "limits.watch_hours", kind: "number", placeholder: "7" },
  { path: ["limits", "develop_budget_seconds"], label: "limits.develop_budget_seconds", kind: "number", placeholder: "5400" },
  { path: ["limits", "stall_seconds"], label: "limits.stall_seconds", kind: "number", placeholder: "2700" },
  { path: ["limits", "review_budget_seconds"], label: "limits.review_budget_seconds", kind: "number", placeholder: "1800" },
  { path: ["limits", "pr_budget_seconds"], label: "limits.pr_budget_seconds", kind: "number", placeholder: "3600" },
  { path: ["limits", "step_budget_seconds"], label: "limits.step_budget_seconds", kind: "number", placeholder: "3600" },
  { path: ["limits", "tick_interval_seconds"], label: "limits.tick_interval_seconds", kind: "number", placeholder: "60" },
  { path: ["limits", "layout_wait_seconds"], label: "limits.layout_wait_seconds", kind: "number", placeholder: "600" },
];

const LABEL_WIDTH = 28;

interface Row {
  container: BoxRenderable;
  label: TextRenderable;
  input: InputRenderable;
  field: FieldDef;
}

export function createConfigEditor(renderer: CliRenderer): TabView {
  const repos = listConfiguredRepos();

  const root = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: "100%", backgroundColor: theme.bg });

  // ── section 1: repo list ────────────────────────────────────────────────────────────────────
  const repoPanel = new BoxRenderable(renderer, {
    width: 30,
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    title: " 1 · repos ",
    titleColor: theme.focusText.unfocused,
  });
  const repoSelect = new SelectRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    options: repos.length ? repos.map((r) => ({ name: r, description: "" })) : [{ name: "(none configured)", description: "" }],
    showDescription: false,
    backgroundColor: theme.bg,
    focusedBackgroundColor: theme.bg,
    textColor: theme.text.secondary,
    focusedTextColor: theme.text.primary,
    selectedBackgroundColor: theme.selection.bg,
    selectedTextColor: theme.selection.fg,
  });
  repoPanel.add(repoSelect);

  // ── section 2: editor form + status line ──────────────────────────────────────────────────
  const rightCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, height: "100%", backgroundColor: theme.bg });
  const form = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    title: " 2 · config ",
    titleColor: theme.focusText.unfocused,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const status = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", fg: theme.text.tertiary, paddingLeft: 1 });
  rightCol.add(form);
  rightCol.add(status);

  root.add(repoPanel);
  root.add(rightCol);

  // ── state ───────────────────────────────────────────────────────────────────────────────────
  let loadedRepo: string | null = null;
  let loadedText = "";
  let rows: Row[] = [];
  let browseIndex = 0;
  let lastSection = 1; // remembered section for restoreFocus (session focus memory)
  let errorNodes: Renderable[] = [];

  function setStatus(content: string, fg: string): void {
    status.content = content;
    status.fg = fg;
  }

  /** Border + title reflect which section holds focus (active = accent, inactive = grey). */
  function setActiveSection(n: 1 | 2): void {
    repoPanel.borderColor = n === 1 ? theme.border.active : theme.border.inactive;
    repoPanel.titleColor = n === 1 ? theme.focusText.focused : theme.focusText.unfocused;
    form.borderColor = n === 2 ? theme.border.active : theme.border.inactive;
    form.titleColor = n === 2 ? theme.focusText.focused : theme.focusText.unfocused;
  }

  function clearForm(): void {
    for (const c of [...form.getChildren()]) {
      form.remove(c.id);
      c.destroy();
    }
    rows = [];
    errorNodes = [];
    browseIndex = 0;
  }

  function clearErrors(): void {
    for (const n of errorNodes) {
      form.remove(n.id);
      n.destroy();
    }
    errorNodes = [];
  }

  function textLine(content: string, fg: string): TextRenderable {
    return new TextRenderable(renderer, { content, fg, width: "100%", height: 1, wrapMode: "none" });
  }

  function addField(f: FieldDef, initial: string): void {
    const container = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: 1, backgroundColor: theme.bg });
    const label = new TextRenderable(renderer, {
      content: "  " + f.label.padEnd(LABEL_WIDTH),
      fg: theme.text.secondary,
      width: LABEL_WIDTH + 3,
      height: 1,
      wrapMode: "none",
    });
    const input = new InputRenderable(renderer, {
      value: initial,
      placeholder: f.placeholder,
      flexGrow: 1,
      backgroundColor: theme.input.bg,
      focusedBackgroundColor: theme.input.focusBg,
      textColor: theme.input.fg,
      focusedTextColor: theme.input.focusFg,
      placeholderColor: theme.input.placeholder,
    });
    const idx = rows.length;
    input.on("input", () => setStatus("● unsaved changes — ^S to save", theme.status.warn));
    input.on("enter", () => onFieldEnter(idx)); // ↵ inside a field → next field
    container.add(label);
    container.add(input);
    form.add(container);
    rows.push({ container, label, input, field: f });
  }

  /** Paint the browse highlight on field `i` (marker + accent label + tinted field), clearing others. */
  function setHighlight(i: number): void {
    if (rows.length === 0) return;
    browseIndex = Math.max(0, Math.min(i, rows.length - 1));
    rows.forEach((r, idx) => {
      const on = idx === browseIndex;
      r.label.content = (on ? "▶ " : "  ") + r.field.label.padEnd(LABEL_WIDTH);
      r.label.fg = on ? theme.focusText.focused : theme.text.secondary;
      r.input.backgroundColor = on ? theme.input.focusBg : theme.input.bg;
    });
    form.scrollChildIntoView(rows[browseIndex]!.container.id);
  }

  function enterEdit(i: number): void {
    if (rows.length === 0) return;
    setHighlight(i);
    rows[browseIndex]!.input.focus();
    setStatus("editing — ↵ next field · Esc: top · ^S save", theme.text.secondary);
  }

  // Called by the shell (↑/↓) while a field is focused — hop to the adjacent field, staying in edit.
  function editMove(dir: -1 | 1): void {
    const next = browseIndex + dir;
    if (next >= 0 && next < rows.length) enterEdit(next);
  }

  function onFieldEnter(i: number): void {
    if (i < rows.length - 1) enterEdit(i + 1); // ↵ = next field; on the last field, stay put
  }

  // Browse-mode keys — only fire while the form itself is focused (a focused field gets keys
  // directly, and the shell routes its ↑/↓ through editMove).
  form.onKeyDown = (key: KeyEvent) => {
    if (rows.length === 0) return;
    if (key.name === "up") {
      setHighlight(browseIndex - 1);
      key.preventDefault();
    } else if (key.name === "down") {
      setHighlight(browseIndex + 1);
      key.preventDefault();
    } else if (key.name === "return" || key.name === "enter") {
      enterEdit(browseIndex);
      key.preventDefault();
    }
  };

  function renderSummary(obj: Record<string, unknown>): void {
    const sources = Array.isArray(obj.work_sources) ? (obj.work_sources as Record<string, unknown>[]) : [];
    const belts = Array.isArray(obj.belt) ? (obj.belt as Record<string, unknown>[]) : [];

    form.add(textLine("", theme.text.tertiary));
    form.add(textLine("work_sources  (view — inline editing next)", theme.accent));
    if (sources.length === 0) form.add(textLine("  (none)", theme.text.tertiary));
    for (const s of sources) {
      const type = String(s.type ?? "?");
      const name = String(s.name ?? type);
      let detail = "";
      if (type === "jira" && s.jira) {
        const j = s.jira as Record<string, unknown>;
        detail = `project ${j.project ?? "?"} · board ${j.board ?? "?"}`;
      } else if (type === "local_markdown" && s.local_markdown) {
        detail = `folder ${(s.local_markdown as Record<string, unknown>).folder ?? "?"}`;
      }
      form.add(textLine(`  • ${name} (${type})  ${detail}`, theme.text.primary));
    }

    form.add(textLine("", theme.text.tertiary));
    form.add(textLine("belts  (view — inline editing next)", theme.accent));
    if (belts.length === 0) form.add(textLine("  (none)", theme.text.tertiary));
    for (const b of belts) {
      const beltType = String(b.belt_type ?? "?");
      form.add(textLine(`  • ${b.name ?? "?"} [${beltType}] source=${b.source ?? "?"} priority=${b.priority ?? 100}`, theme.text.primary));
      if (beltType === "custom" && Array.isArray(b.steps)) {
        const names = (b.steps as Record<string, unknown>[]).map((s) => String(s.name ?? "?")).join(" → ");
        form.add(textLine(`      steps: ${names}`, theme.text.secondary));
      } else if (beltType === "work_to_pull_request" && b.agents) {
        form.add(textLine(`      agents: ${Object.keys(b.agents as object).join(", ")}`, theme.text.secondary));
      }
    }
  }

  function loadRepo(name: string): void {
    const path = join(repoConfigDir(name), "config.yml");
    clearForm();
    if (!existsSync(path)) {
      form.title = ` 2 · ${name} `;
      form.add(textLine(`no config.yml at ${path}`, theme.status.bad));
      setStatus("", theme.text.tertiary);
      return;
    }
    loadedRepo = name;
    loadedText = readFileSync(path, "utf8");
    const doc = parseDocument(loadedText);
    form.title = ` 2 · ${name}/config.yml `;

    if (doc.errors.length > 0) {
      form.add(textLine(`✗ cannot parse YAML: ${doc.errors[0]?.message ?? "parse error"}`, theme.status.bad));
      setStatus("fix the YAML before editing", theme.status.bad);
      return;
    }

    form.add(textLine("repo", theme.accent));
    for (const f of FIELDS.filter((f) => f.path[0] === "repo")) {
      const v = doc.getIn(f.path);
      addField(f, v == null ? "" : String(v));
    }
    form.add(textLine("", theme.text.tertiary));
    form.add(textLine("limits", theme.accent));
    for (const f of FIELDS.filter((f) => f.path[0] === "limits")) {
      const v = doc.getIn(f.path);
      addField(f, v == null ? "" : String(v));
    }

    renderSummary(doc.toJS() as Record<string, unknown>);
    setHighlight(0);
    setStatus("↵ open a field to edit · ^S save", theme.text.secondary);
  }

  function save(): void {
    if (!loadedRepo) {
      setStatus("select a repo first", theme.text.tertiary);
      return;
    }
    const path = join(repoConfigDir(loadedRepo), "config.yml");
    // Re-parse the loaded text fresh so a rejected save never leaves partial edits behind.
    const doc = parseDocument(loadedText);
    if (doc.errors.length > 0) {
      setStatus(`✗ cannot parse YAML: ${doc.errors[0]?.message ?? "parse error"}`, theme.status.bad);
      return;
    }

    for (const { field, input } of rows) {
      const raw = input.value.trim();
      if (raw === "") continue; // empty = leave as-is (don't delete / don't force a default)
      const val: string | number = field.kind === "number" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      if (String(doc.getIn(field.path) ?? "") !== String(val)) doc.setIn(field.path, val);
    }

    clearErrors();
    const parsed = RepoConfigSchema.safeParse(doc.toJS());
    if (!parsed.success) {
      parsed.error.issues.slice(0, 6).forEach((i, idx) => {
        const node = textLine(`  ✗ ${i.path.join(".") || "(root)"}: ${i.message}`, theme.status.bad);
        form.add(node, idx);
        errorNodes.push(node);
      });
      setStatus(`✗ ${parsed.error.issues.length} validation error(s) — not saved`, theme.status.bad);
      return;
    }

    const text = doc.toString();
    writeFileSync(path, text);
    loadedText = text;
    setStatus("✓ saved", theme.status.good);
    void postReload().then((ok) => {
      if (ok && loadedRepo) setStatus("✓ saved · server reloaded", theme.status.good);
    });
  }

  repoSelect.on("itemSelected", () => {
    const opt = repoSelect.getSelectedOption();
    if (opt && opt.name !== "(none configured)") {
      loadRepo(opt.name);
      focusSection(2); // jump straight into the fields after opening a repo
    }
  });

  function focusSection(n: number): void {
    if (n === 1) {
      lastSection = 1;
      setActiveSection(1);
      repoSelect.focus();
    } else if (n === 2) {
      lastSection = 2;
      setActiveSection(2);
      form.focus();
      if (rows.length > 0) setHighlight(Math.min(browseIndex, rows.length - 1));
    }
  }

  return {
    root,
    sectionCount: 2,
    focusSection,
    restoreFocus() {
      focusSection(lastSection);
    },
    activate() {
      const first = repos[0];
      if (!loadedRepo && first) loadRepo(first);
    },
    deactivate() {
      /* no timers to stop */
    },
    save,
    editMove,
  };
}
