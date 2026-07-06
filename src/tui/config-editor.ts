// Config tab — two numbered sections: [1] a repo list, [2] a full editor for the selected repo's
// config.yml. Section 2 renders a flat, browsable list of rows generated from a live `yaml` Document
// (config-fields.ts). Array-of-object items (work_sources, belts, steps) render as collapsible
// `group` rows — collapsed by default, toggled with ↵/Space/←→ or a mouse click — so long configs
// stay scannable. Text fields, cyclable enums, bool toggles, source refs, and add/remove action
// rows fill in when a group is expanded. Navigation follows the shell's lazygit model (↑↓ move, Esc
// → top). Structural edits mutate the Document surgically so comments + the schema modeline are
// preserved; save validates against RepoConfigSchema before writing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent, Renderable } from "@opentui/core";
import { parseDocument, type Document } from "yaml";
import { RepoConfigSchema, listConfiguredRepos, loadEnvMap, repoConfigDir, saveEnvValues } from "../config.ts";
import { SOURCE_DESCRIPTORS } from "../sources/registry.ts";
import { postReload } from "./api.ts";
import { buildDescriptors, type FieldDesc } from "./config-fields.ts";
import { BORDER, theme } from "./theme.ts";
import type { ConfirmFn, TabView } from "./types.ts";

const LABEL_WIDTH = 28;
const IND = (n?: number) => "  ".repeat(n ?? 0);
const gut = (on: boolean) => (on ? "▶ " : "  ");

interface RowRef {
  desc: FieldDesc;
  container: Renderable;
  input?: InputRenderable;
  setHighlighted: (on: boolean) => void;
}

export function createConfigEditor(renderer: CliRenderer, confirm: ConfirmFn): TabView {
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
  let draft: Document | null = null;
  let focusRows: RowRef[] = [];
  let browseIndex = 0;
  let lastSection = 1;
  let errorNodes: Renderable[] = [];
  let expandedNodes = new WeakSet<object>(); // which array-item nodes are expanded (view state)
  // Per-repo credentials (separate `env` file). `envValues` is live (updated by flush);
  // `loadedEnv` is the on-disk snapshot, so save only writes when they differ. Which keys are
  // shown comes from the source descriptors' secrets manifests — not hardcoded per backend.
  let envValues: Record<string, string> = {};
  let loadedEnv: Record<string, string> = {};
  const secretGet = (envKey: string) => envValues[envKey] ?? "";
  const secretSet = (envKey: string, v: string) => { envValues[envKey] = v; };

  // The env-backed credential fields, prepended above the config.yml form: every source type's
  // manifest, deduped by env key (a key two types share renders once).
  const secretDescriptors = (): FieldDesc[] => {
    const rows: FieldDesc[] = [{ kind: "header", label: "secrets (env)", level: 1 }];
    const seen = new Set<string>();
    for (const d of SOURCE_DESCRIPTORS) {
      for (const s of d.secrets) {
        if (seen.has(s.envKey)) continue;
        seen.add(s.envKey);
        rows.push({ kind: "text", label: s.envKey, env: s.envKey, masked: s.masked, placeholder: s.placeholder ?? (s.required ? undefined : "(optional)"), indent: 1 });
      }
    }
    return rows;
  };

  function setStatus(content: string, fg: string): void {
    status.content = content;
    status.fg = fg;
  }
  const markUnsaved = () => setStatus("● unsaved changes — ^S to save", theme.status.warn);

  function setActiveSection(n: 1 | 2): void {
    repoPanel.borderColor = n === 1 ? theme.border.active : theme.border.inactive;
    repoPanel.titleColor = n === 1 ? theme.focusText.focused : theme.focusText.unfocused;
    form.borderColor = n === 2 ? theme.border.active : theme.border.inactive;
    form.titleColor = n === 2 ? theme.focusText.focused : theme.focusText.unfocused;
  }

  function clearFormChildren(): void {
    for (const c of [...form.getChildren()]) {
      form.remove(c.id);
      c.destroy();
    }
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

  // Render one descriptor into the form; returns a RowRef for focusable ones, null for headers.
  function renderDescriptor(d: FieldDesc): RowRef | null {
    if (d.kind === "header") {
      const fg = d.level === 1 ? theme.accent : theme.text.secondary;
      form.add(new TextRenderable(renderer, { content: IND(d.indent) + d.label, fg, width: "100%", height: 1, wrapMode: "none" }));
      return null;
    }
    if (d.kind === "group") {
      const body = () => `${IND(d.indent)}${d.expanded ? "▾" : "▸"} ${d.label}`;
      const t = new TextRenderable(renderer, { content: gut(false) + body(), fg: theme.text.primary, width: "100%", height: 1, wrapMode: "none" });
      form.add(t);
      return { desc: d, container: t, setHighlighted: (on) => { t.content = gut(on) + body(); t.fg = on ? theme.focusText.focused : theme.text.primary; } };
    }
    if (d.kind === "action") {
      const t = new TextRenderable(renderer, { content: gut(false) + IND(d.indent) + d.label, fg: theme.accent, width: "100%", height: 1, wrapMode: "none" });
      form.add(t);
      return { desc: d, container: t, setHighlighted: (on) => { t.content = gut(on) + IND(d.indent) + d.label; t.fg = on ? theme.focusText.focused : theme.accent; } };
    }

    const container = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: 1, backgroundColor: theme.bg });
    const labelText = IND(d.indent) + d.label.padEnd(LABEL_WIDTH);
    const labelW = 2 + (d.indent ?? 0) * 2 + LABEL_WIDTH + 1;
    const label = new TextRenderable(renderer, { content: gut(false) + labelText, fg: theme.text.secondary, width: labelW, height: 1, wrapMode: "none" });
    container.add(label);

    if (d.kind === "text") {
      let initial = "";
      let placeholder = d.placeholder ?? "";
      if (d.env) {
        // env-backed credential: token is replace-only (never render the stored value).
        if (d.masked) placeholder = secretGet(d.env) ? "•••••••• (set — type to replace)" : "not set";
        else initial = secretGet(d.env);
      } else {
        const v = draft?.getIn(d.path!);
        initial = v == null ? "" : String(v);
      }
      const input = new InputRenderable(renderer, {
        value: initial,
        placeholder,
        flexGrow: 1,
        backgroundColor: theme.input.bg,
        focusedBackgroundColor: theme.input.focusBg,
        textColor: theme.input.fg,
        focusedTextColor: theme.input.focusFg,
        placeholderColor: theme.input.placeholder,
      });
      input.on("input", markUnsaved);
      input.on("enter", () => moveHighlight(browseIndex + 1, true));
      container.add(input);
      form.add(container);
      return {
        desc: d,
        container,
        input,
        setHighlighted: (on) => {
          label.content = gut(on) + labelText;
          label.fg = on ? theme.focusText.focused : theme.text.secondary;
          input.backgroundColor = on ? theme.input.focusBg : theme.input.bg;
        },
      };
    }

    // enum | ref | bool → a value chip
    const display = d.kind === "bool" ? (d.value ? "[x] on" : "[ ] off") : `‹ ${d.value} ›`;
    const val = new TextRenderable(renderer, { content: display, fg: theme.text.primary, flexGrow: 1, height: 1, wrapMode: "none" });
    container.add(val);
    form.add(container);
    return {
      desc: d,
      container,
      setHighlighted: (on) => {
        label.content = gut(on) + labelText;
        label.fg = on ? theme.focusText.focused : theme.text.secondary;
        val.fg = on ? theme.accent : theme.text.primary;
      },
    };
  }

  function render(): void {
    clearFormChildren();
    focusRows = [];
    errorNodes = [];
    if (!draft) return;
    for (const d of [...secretDescriptors(), ...buildDescriptors(draft, rebuild, confirm, expandedNodes)]) {
      const rr = renderDescriptor(d);
      if (!rr) continue;
      focusRows.push(rr);
      const idx = focusRows.length - 1;
      // Mouse: click any row to highlight it; click a group to toggle expand/collapse.
      rr.container.onMouseDown = () => {
        setHighlight(idx);
        if (d.kind === "group") toggleGroup(d.node);
      };
    }
  }

  function setHighlight(i: number): void {
    if (focusRows.length === 0) return;
    browseIndex = Math.max(0, Math.min(i, focusRows.length - 1));
    focusRows.forEach((r, idx) => r.setHighlighted(idx === browseIndex));
    form.scrollChildIntoView(focusRows[browseIndex]!.container.id);
  }

  /** Commit every visible text field's value into the draft (so nothing is lost on rebuild/save). */
  function flushInputs(): void {
    if (!draft) return;
    for (const r of focusRows) {
      if (r.desc.kind !== "text" || !r.input) continue;
      const d = r.desc;
      const raw = r.input.value;
      if (d.env) {
        // token (masked) is replace-only: blank keeps the existing one; email always applies.
        if (d.masked) { if (raw.trim() !== "") secretSet(d.env, raw.trim()); } else secretSet(d.env, raw.trim());
        continue;
      }
      const t = raw.trim();
      if (t === "") continue;
      const value = d.numeric && Number.isFinite(Number(t)) ? Number(t) : t;
      draft.setIn(d.path!, value);
    }
  }

  // Regenerate rows after a STRUCTURAL change (add/remove/type-switch). Callers flush BEFORE mutating
  // the draft (see activate/cycle), so this must not flush again — paths have shifted.
  function rebuild(): void {
    const keep = browseIndex;
    render();
    setHighlight(keep);
    form.focus();
    markUnsaved();
  }

  // Expand/collapse a group. View-only (doesn't touch the config), so it flushes visible edits and
  // re-renders without marking unsaved.
  function toggleGroup(node: object): void {
    flushInputs();
    if (expandedNodes.has(node)) expandedNodes.delete(node);
    else expandedNodes.add(node);
    const keep = browseIndex;
    render();
    setHighlight(keep);
    form.focus();
  }

  function enterEdit(i: number): void {
    setHighlight(i);
    const row = focusRows[browseIndex];
    if (row?.input) {
      row.input.focus();
      setStatus("editing — ↵ next · Esc: top · ^S save", theme.text.secondary);
    }
  }

  function moveHighlight(target: number, edit: boolean): void {
    flushInputs();
    if (focusRows.length === 0) return;
    setHighlight(target);
    const row = focusRows[browseIndex];
    if (edit && row?.input) row.input.focus();
    else form.focus();
  }

  function cycle(desc: Extract<FieldDesc, { kind: "enum" | "ref" }>, dir: 1 | -1): void {
    flushInputs(); // capture typed edits before the mutation shifts draft paths
    const cs = desc.choices;
    if (cs.length === 0) return;
    const i = cs.indexOf(desc.value);
    const next = i < 0 ? cs[0]! : cs[(i + dir + cs.length) % cs.length]!;
    desc.apply(next); // mutates draft → rebuild()
  }

  function activate(row: RowRef | undefined): void {
    if (!row) return;
    const d = row.desc;
    if (d.kind === "text") {
      enterEdit(browseIndex);
    } else if (d.kind === "enum" || d.kind === "ref") {
      cycle(d, 1);
    } else if (d.kind === "bool") {
      flushInputs();
      d.apply(!d.value);
    } else if (d.kind === "action") {
      flushInputs();
      d.run();
    } else if (d.kind === "group") {
      toggleGroup(d.node);
    }
  }

  // Browse-mode keys — only fire while the form itself is focused.
  form.onKeyDown = (key: KeyEvent) => {
    if (focusRows.length === 0) return;
    const row = focusRows[browseIndex];
    const cyclable = !!row && (row.desc.kind === "enum" || row.desc.kind === "ref");
    const group = row && row.desc.kind === "group" ? row.desc : null;
    // Reorder a group within its array: Shift+↑/↓ or [ / ].
    if (group) {
      const up = (key.name === "up" && key.shift) || key.name === "[";
      const down = (key.name === "down" && key.shift) || key.name === "]";
      if (up || down) {
        flushInputs();
        if (up) group.moveUp?.();
        else group.moveDown?.();
        key.preventDefault();
        return;
      }
    }
    switch (key.name) {
      case "up":
        moveHighlight(browseIndex - 1, false);
        key.preventDefault();
        break;
      case "down":
        moveHighlight(browseIndex + 1, false);
        key.preventDefault();
        break;
      case "return":
      case "enter":
        activate(row);
        key.preventDefault();
        break;
      case "space":
        if (row && (cyclable || row.desc.kind === "bool" || row.desc.kind === "group")) {
          activate(row);
          key.preventDefault();
        }
        break;
      case "left":
        if (cyclable) cycle(row!.desc as Extract<FieldDesc, { kind: "enum" | "ref" }>, -1);
        else if (group && expandedNodes.has(group.node)) toggleGroup(group.node);
        else break;
        key.preventDefault();
        break;
      case "right":
        if (cyclable) cycle(row!.desc as Extract<FieldDesc, { kind: "enum" | "ref" }>, 1);
        else if (group && !expandedNodes.has(group.node)) toggleGroup(group.node);
        else break;
        key.preventDefault();
        break;
    }
  };

  function loadRepo(name: string): void {
    loadedRepo = null;
    draft = null;
    focusRows = [];
    errorNodes = [];
    browseIndex = 0;
    expandedNodes = new WeakSet(); // fresh document → fresh collapse state (all collapsed)
    clearFormChildren();

    const path = join(repoConfigDir(name), "config.yml");
    if (!existsSync(path)) {
      form.title = ` 2 · ${name} `;
      form.add(textLine(`no config.yml at ${path}`, theme.status.bad));
      setStatus("", theme.text.tertiary);
      return;
    }
    loadedText = readFileSync(path, "utf8");
    const doc = parseDocument(loadedText);
    form.title = ` 2 · ${name}/config.yml `;
    if (doc.errors.length > 0) {
      form.add(textLine(`✗ cannot parse YAML: ${doc.errors[0]?.message ?? "parse error"}`, theme.status.bad));
      setStatus("fix the YAML before editing", theme.status.bad);
      return;
    }
    loadedRepo = name;
    draft = doc;
    loadedEnv = loadEnvMap(repoConfigDir(name));
    envValues = { ...loadedEnv };
    render();
    setHighlight(0);
    setStatus("↑↓ move · ↵ open/edit/cycle · ^S save", theme.text.secondary);
  }

  function save(): void {
    if (!loadedRepo || !draft) {
      setStatus("select a repo first", theme.text.tertiary);
      return;
    }
    flushInputs();
    // Credentials live in a separate `env` file (no schema validation) — save them independently
    // of config validity when they've changed.
    const changed = Object.entries(envValues).filter(([k, v]) => v !== (loadedEnv[k] ?? ""));
    if (changed.length > 0) {
      saveEnvValues(repoConfigDir(loadedRepo), Object.fromEntries(changed));
      loadedEnv = { ...loadedEnv, ...Object.fromEntries(changed) };
    }
    clearErrors();
    const parsed = RepoConfigSchema.safeParse(draft.toJS());
    if (!parsed.success) {
      parsed.error.issues.slice(0, 6).forEach((iss, idx) => {
        const node = textLine(`  ✗ ${iss.path.join(".") || "(root)"}: ${iss.message}`, theme.status.bad);
        form.add(node, idx);
        errorNodes.push(node);
      });
      setStatus(`✗ ${parsed.error.issues.length} validation error(s) — not saved`, theme.status.bad);
      return;
    }
    const text = draft.toString();
    writeFileSync(join(repoConfigDir(loadedRepo), "config.yml"), text);
    loadedText = text;
    setStatus("✓ saved", theme.status.good);
    void postReload().then((outcome) => {
      if (!loadedRepo || !outcome.reached) return;
      const failed = outcome.failures.find((f) => f.name === loadedRepo) ?? outcome.failures[0];
      if (failed) {
        // The save was schema-valid but the server could NOT load the repo (e.g. a source whose
        // client can't be constructed) — the repo is NOT ticking; "reloaded" would be a lie.
        setStatus(`✗ saved, but repo "${failed.name}" failed to load: ${failed.error}`, theme.status.bad);
      } else {
        setStatus("✓ saved · server reloaded", theme.status.good);
      }
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
      if (focusRows.length > 0) setHighlight(Math.min(browseIndex, focusRows.length - 1));
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
    editMove(dir: -1 | 1) {
      moveHighlight(browseIndex + dir, true);
    },
  };
}
