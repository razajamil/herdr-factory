// The TUI config editor's field builder — specifically that a source's descriptor `tui.fields`
// render, including the new enum (pick-list) support that surfaces jira's auth.method.
import { describe, it, expect } from "vitest";
import { parseDocument, type Document } from "yaml";
import { buildDescriptors, type FieldDesc } from "../src/tui/config-fields.ts";

/** Build the field list with the given source expanded (its inner fields only render when open). */
function fieldsFor(doc: Document): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const src = doc.getIn(["work_sources", 0]) as object;
  if (src) expanded.add(src);
  return buildDescriptors(
    doc,
    () => {},
    async () => true,
    expanded,
    "work_sources",
  );
}

const jiraDoc = () =>
  parseDocument(`work_sources:
  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: P
      board: "1"
belt: []
`);

describe("config-fields: jira auth.method", () => {
  it("renders auth.method as an enum (api_token | oauth), defaulting to api_token when unset", () => {
    const auth = fieldsFor(jiraDoc()).find((f) => f.kind === "enum" && f.label === "auth.method");
    expect(auth).toBeTruthy();
    if (auth?.kind !== "enum") throw new Error("expected an enum field");
    expect(auth.choices).toEqual(["api_token", "oauth"]);
    expect(auth.value).toBe("api_token"); // no `auth` block yet ⇒ shows the schema default
  });

  it("picking oauth writes auth.method into the document (creating the auth block)", () => {
    const doc = jiraDoc();
    const auth = fieldsFor(doc).find((f) => f.kind === "enum" && f.label === "auth.method");
    if (auth?.kind !== "enum") throw new Error("expected an enum field");
    auth.apply("oauth");
    expect(doc.getIn(["work_sources", 0, "jira", "auth", "method"])).toBe("oauth");
  });

  it("reflects an existing auth.method value", () => {
    const doc = parseDocument(`work_sources:
  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: P
      board: "1"
      auth: { method: oauth }
belt: []
`);
    const auth = fieldsFor(doc).find((f) => f.kind === "enum" && f.label === "auth.method");
    if (auth?.kind !== "enum") throw new Error("expected an enum field");
    expect(auth.value).toBe("oauth");
  });
});

/** Build the belt-section fields with belt 0 and its step 0 expanded (inner fields render only when open). */
function beltStepFields(doc: Document): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const belt = doc.getIn(["belt", 0]) as object;
  const step = doc.getIn(["belt", 0, "steps", 0]) as object;
  if (belt) expanded.add(belt);
  if (step) expanded.add(step);
  return buildDescriptors(doc, () => {}, async () => true, expanded, "belt");
}

const beltWithPromptDoc = () =>
  parseDocument(`work_sources: []
belt:
  - name: b
    source: s
    steps:
      - type: custom
        name: do_thing
        prompt_file: prompts/step.md
        prompt_file_source: config
`);

describe("config-fields: clearable optional scalars (unset-in-place regression)", () => {
  // Repro of the reported bug: a step that HAD a prompt_file can't be saved after clearing it,
  // because a non-clearable text field skips empties on flush and the stale value survives. These
  // optional scalars must be `clearable` so blanking them deletes the key.
  it.each(["prompt_file", "tab", "pane", "budget_seconds"])(
    "marks the belt step's %s field clearable",
    (label) => {
      const f = beltStepFields(beltWithPromptDoc()).find((x) => x.kind === "text" && x.label === label);
      if (f?.kind !== "text") throw new Error(`expected a text field for ${label}`);
      expect(f.clearable).toBe(true);
    },
  );

  it.each(["workspace_name", "match"])("marks the belt's %s field clearable", (label) => {
    const f = beltStepFields(beltWithPromptDoc()).find((x) => x.kind === "text" && x.label === label);
    if (f?.kind !== "text") throw new Error(`expected a text field for ${label}`);
    expect(f.clearable).toBe(true);
  });

  it("leaves a required scalar (belt name) non-clearable so a blank can't silently drop it", () => {
    const f = beltStepFields(beltWithPromptDoc()).find((x) => x.kind === "text" && x.label === "name" && "path" in x && (x.path as (string | number)[])?.[2] === "name");
    if (f?.kind !== "text") throw new Error("expected the belt name text field");
    expect(f.clearable).toBeUndefined();
  });
});

// ── section 4: layouts (the repo-level herdr tab/pane library the factory builds into worktrees) ──
function layoutFields(doc: Document, openPaths: (string | number)[][] = []): FieldDesc[] {
  const expanded = new WeakSet<object>();
  for (const p of openPaths) {
    const n = doc.getIn(p) as object;
    if (n) expanded.add(n);
  }
  return buildDescriptors(doc, () => {}, async () => true, expanded, "layouts");
}

const layoutDoc = () =>
  parseDocument(`work_sources: []
belt: []
layouts:
  - id: app-dev
    tabs:
      - title: work
        panes:
          - { title: agent, command: claude }
          - { title: server, command: mise run dev, split: right, size: "40%" }
`);

describe("config-fields: layouts section", () => {
  it("lists each layout as a collapsible group labelled by id + tab count", () => {
    const g = layoutFields(layoutDoc()).find((f) => f.kind === "group");
    if (g?.kind !== "group") throw new Error("expected a layout group row");
    expect(g.label).toBe("app-dev [1 tab]");
  });

  it("+ add layout creates a `layouts` array even when the key is absent (optional block)", () => {
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const add = layoutFields(doc).find((f) => f.kind === "action" && f.label === "+ add layout");
    if (add?.kind !== "action") throw new Error("expected the add-layout action");
    add.run();
    expect(doc.getIn(["layouts", 0, "id"])).toBe("layout");
    expect(doc.getIn(["layouts", 0, "tabs", 0, "panes", 0, "command"])).toBe("claude");
  });

  it("exposes a pane's split as an enum with an (unset) clear option", () => {
    const paths = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 1]];
    const split = layoutFields(layoutDoc(), paths).find((f) => f.kind === "enum" && f.label === "split");
    if (split?.kind !== "enum") throw new Error("expected the pane split enum");
    expect(split.value).toBe("right");
    expect(split.choices).toEqual(["(unset)", "vertical", "horizontal", "right", "down"]);
    split.apply("(unset)");
  });

  it("marks pane title/command/size clearable so they can be unset in place", () => {
    const paths = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 0]];
    const fields = layoutFields(layoutDoc(), paths);
    for (const label of ["command", "size"]) {
      const f = fields.find((x) => x.kind === "text" && x.label === label);
      if (f?.kind !== "text") throw new Error(`expected a text field for ${label}`);
      expect(f.clearable).toBe(true);
    }
  });
});

describe("config-fields: belt references a layout", () => {
  const doc = () =>
    parseDocument(`work_sources: []
belt:
  - name: b
    source: s
    steps: [{ type: work }]
layouts:
  - id: app-dev
    tabs: [{ title: work, panes: [{ title: agent, command: claude }] }]
`);

  it("offers default_layout as an enum over the defined layout ids (+ an (unset) option)", () => {
    const d = doc();
    const expanded = new WeakSet<object>();
    expanded.add(d.getIn(["belt", 0]) as object);
    const dl = buildDescriptors(d, () => {}, async () => true, expanded, "belt").find((f) => f.kind === "enum" && f.label === "default_layout");
    if (dl?.kind !== "enum") throw new Error("expected the default_layout enum");
    expect(dl.choices).toEqual(["(unset)", "app-dev"]);
    dl.apply("app-dev");
    expect(d.getIn(["belt", 0, "default_layout"])).toBe("app-dev");
  });
});
