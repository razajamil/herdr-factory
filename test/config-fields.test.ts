// The TUI config editor's field builder — specifically that a source's descriptor `tui.fields`
// render, including the new enum (pick-list) support that surfaces jira's auth.method.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, type Document } from "yaml";
import { buildDescriptors, type FieldCtx, type FieldDesc } from "../src/tui/config-fields.ts";
import { RepoConfigSchema } from "../src/config.ts";
import { validatePromptBody } from "../src/prompts/contract.ts";

/** A default field-builder ctx for tests: modal helpers stubbed, no repo dir / assist wiring.
 *  Override per test (e.g. a `choose` that picks a preset, or a `repoDir` + `writeStub` for the
 *  referenced-file assist). */
const ctx = (over: Partial<FieldCtx> = {}): FieldCtx => ({ confirm: async () => true, choose: async () => null, ...over });

/** Flush the microtask + timer queue so an async action (a `void choose().then(...)`) has settled. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// Real temp config dirs for the referenced-file assist (existsSync is real IO), cleaned per test.
const tmps: string[] = [];
afterEach(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); tmps.length = 0; });
const tmpRepoDir = (): string => { const d = mkdtempSync(join(tmpdir(), "cfg-fields-")); tmps.push(d); return d; };
const actionRun = (fields: FieldDesc[], label: string): void => {
  const a = fields.find((f) => f.kind === "action" && f.label === label);
  if (a?.kind !== "action") throw new Error(`expected the "${label}" action`);
  a.run();
};

/** Build the field list with the given source expanded (its inner fields only render when open). */
function fieldsFor(doc: Document): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const src = doc.getIn(["work_sources", 0]) as object;
  if (src) expanded.add(src);
  return buildDescriptors(doc, () => {}, ctx(), expanded, "work_sources");
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

describe("config-fields: source poll_interval_seconds", () => {
  it("renders a clearable numeric poll_interval_seconds row for every source (common field)", () => {
    const f = fieldsFor(jiraDoc()).find(
      (x) => x.kind === "text" && x.label === "poll_interval_seconds" && "path" in x && (x.path as (string | number)[])?.[2] === "poll_interval_seconds",
    );
    if (f?.kind !== "text") throw new Error("expected the poll_interval_seconds text field");
    expect(f.numeric).toBe(true);
    expect(f.clearable).toBe(true); // blank ⇒ falls back to the repo default, not written
    expect(f.path).toEqual(["work_sources", 0, "poll_interval_seconds"]);
  });

  it("surfaces source_poll_interval_seconds in the limits panel", () => {
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const general = buildDescriptors(doc, () => {}, ctx(), new WeakSet(), "general");
    const lim = general.find((x) => x.kind === "text" && x.label === "source_poll_interval_seconds");
    expect(lim).toBeTruthy();
    if (lim?.kind === "text") expect(lim.path).toEqual(["limits", "source_poll_interval_seconds"]);
  });
});

describe("config-fields: jira board (api_token only — no auth field)", () => {
  it("renders a jira.board text field bound to the board path", () => {
    const board = fieldsFor(jiraDoc()).find((f) => f.kind === "text" && f.label === "jira.board");
    expect(board?.kind).toBe("text");
    if (board?.kind === "text") expect(board.path).toEqual(["work_sources", 0, "jira", "board"]);
  });

  it("no longer offers an auth.method field (Jira is api_token only)", () => {
    expect(fieldsFor(jiraDoc()).some((f) => f.kind === "enum" && f.label === "auth.method")).toBe(false);
  });
});

/** Build the belt-section fields with belt 0 and its step 0 expanded (inner fields render only when open). */
function beltStepFields(doc: Document): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const belt = doc.getIn(["belt", 0]) as object;
  const step = doc.getIn(["belt", 0, "steps", 0]) as object;
  if (belt) expanded.add(belt);
  if (step) expanded.add(step);
  return buildDescriptors(doc, () => {}, ctx(), expanded, "belt");
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
  return buildDescriptors(doc, () => {}, ctx(), expanded, "layouts");
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
    const dl = buildDescriptors(d, () => {}, ctx(), expanded, "belt").find((f) => f.kind === "enum" && f.label === "default_layout");
    if (dl?.kind !== "enum") throw new Error("expected the default_layout enum");
    expect(dl.choices).toEqual(["(unset)", "app-dev"]);
    dl.apply("app-dev");
    expect(d.getIn(["belt", 0, "default_layout"])).toBe("app-dev");
  });
});

const sentryDoc = () =>
  parseDocument(`work_sources:
  - type: sentry
    sentry:
      organization: acme
      projects: [backend, web]
      environment: [production]
belt: []
`);

describe("config-fields: sentry list fields (projects/environment)", () => {
  it("renders a header + one editable text row per element (pointing at the array indices) + an add action", () => {
    const fields = fieldsFor(sentryDoc());
    expect(fields.some((f) => f.kind === "header" && f.label === "sentry.projects")).toBe(true);
    const elems = fields.filter((f) => f.kind === "text" && "path" in f && (f.path as (string | number)[])?.[3] === "projects");
    expect(elems.map((f) => (f as Extract<FieldDesc, { kind: "text" }>).path)).toEqual([
      ["work_sources", 0, "sentry", "projects", 0],
      ["work_sources", 0, "sentry", "projects", 1],
    ]);
    expect(fields.some((f) => f.kind === "action" && f.label === "+ add sentry.projects")).toBe(true);
    expect(fields.some((f) => f.kind === "action" && f.label === "+ add sentry.environment")).toBe(true);
  });

  it("+ add appends an empty element to the YAML array", () => {
    const doc = sentryDoc();
    const add = fieldsFor(doc).find((f) => f.kind === "action" && f.label === "+ add sentry.environment");
    if (add?.kind === "action") add.run();
    expect((doc.toJS() as { work_sources: { sentry: { environment: string[] } }[] }).work_sources[0]!.sentry.environment).toEqual(["production", ""]);
  });

  it("+ add creates the array when the key is absent", () => {
    const doc = parseDocument("work_sources:\n  - type: sentry\n    sentry: { organization: acme }\nbelt: []\n");
    const add = fieldsFor(doc).find((f) => f.kind === "action" && f.label === "+ add sentry.projects");
    if (add?.kind === "action") add.run();
    expect((doc.toJS() as { work_sources: { sentry: { projects: string[] } }[] }).work_sources[0]!.sentry.projects).toEqual([""]);
  });

  it("the first ‹ remove › deletes projects[0]", () => {
    const doc = sentryDoc();
    const remove = fieldsFor(doc).find((f) => f.kind === "action" && f.label === "‹ remove ›"); // projects render first
    if (remove?.kind === "action") remove.run();
    expect((doc.toJS() as { work_sources: { sentry: { projects: string[] } }[] }).work_sources[0]!.sentry.projects).toEqual(["web"]);
  });
});

// ── belt presets ("+ add belt" offers a pipeline preset via the choose modal) ──
const jiraSourceDoc = () =>
  parseDocument(`repo:\n  path: /tmp/repo\nwork_sources:\n  - { type: jira, name: jira, jira: { base_url: "https://x.atlassian.net", project: P, board: "1" } }\nbelt: []\n`);
const mdSourceDoc = () =>
  parseDocument(`repo:\n  path: /tmp/repo\nwork_sources:\n  - { type: local_markdown, name: briefs, local_markdown: { folder: "~/x" } }\nbelt: []\n`);
const addBelt = async (doc: Document, preset: "ticket_pr" | "custom"): Promise<Record<string, any>> => {
  actionRun(buildDescriptors(doc, () => {}, ctx({ choose: async () => preset }), new WeakSet(), "belt"), "+ add belt");
  await flush();
  return (doc.toJS() as { belt: Record<string, any>[] }).belt[0]!;
};

describe("config-fields: + add belt presets", () => {
  it("ticket → PR preset seeds a work→review→pr belt WITH a label for a label-driven source", async () => {
    const b = await addBelt(jiraSourceDoc(), "ticket_pr");
    expect(b.source).toBe("jira");
    expect(b.label).toBe("agent");
    expect(b.steps.map((s: any) => s.type)).toEqual(["work", "review", "pr"]);
  });

  it("ticket → PR preset omits the label for a label-less source (local_markdown)", async () => {
    const b = await addBelt(mdSourceDoc(), "ticket_pr");
    expect(b.source).toBe("briefs");
    expect("label" in b).toBe(false);
    expect(b.steps.map((s: any) => s.type)).toEqual(["work", "review", "pr"]);
  });

  it("custom preset seeds the historical single-work-step belt (no label)", async () => {
    const b = await addBelt(jiraSourceDoc(), "custom");
    expect(b.steps.map((s: any) => s.type)).toEqual(["work"]);
    expect("label" in b).toBe(false);
  });

  it("a dismissed preset picker (choose → null) adds no belt", async () => {
    const doc = jiraSourceDoc();
    actionRun(buildDescriptors(doc, () => {}, ctx({ choose: async () => null }), new WeakSet(), "belt"), "+ add belt");
    await flush();
    expect((doc.toJS() as { belt: unknown[] }).belt).toEqual([]);
  });

  it("the presets produce belts that pass RepoConfigSchema", async () => {
    // The curated ticket → PR preset validates on either source kind; the custom preset validates on
    // a label-less source (on a label-driven one it needs the required label filled — as it always did).
    for (const [docFn, preset] of [[jiraSourceDoc, "ticket_pr"], [mdSourceDoc, "ticket_pr"], [mdSourceDoc, "custom"]] as const) {
      const doc = docFn();
      await addBelt(doc, preset);
      const res = RepoConfigSchema.safeParse(doc.toJS());
      expect(res.success, `${docFn.name}/${preset}: ${res.success ? "" : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });
});

describe("config-fields: + add step defaults to work", () => {
  it("seeds a `work` step (not `custom`)", () => {
    const doc = parseDocument(`work_sources: []\nbelt:\n  - name: b\n    source: s\n    steps: [{ type: work }]\n`);
    const expanded = new WeakSet<object>();
    expanded.add(doc.getIn(["belt", 0]) as object);
    actionRun(buildDescriptors(doc, () => {}, ctx(), expanded, "belt"), "+ add step");
    const steps = (doc.toJS() as { belt: { steps: { type: string }[] }[] }).belt[0]!.steps;
    expect(steps[steps.length - 1]!.type).toBe("work");
  });
});

// ── referenced-file assist: offer to create a missing config-sourced prompt_file / match ──
const stepDoc = (source: "config" | "repo") =>
  parseDocument(`work_sources: []\nbelt:\n  - name: b\n    source: s\n    steps:\n      - { type: custom, name: do, prompt_file: prompts/step.md, prompt_file_source: ${source} }\n`);
const openBeltStep = (doc: Document): WeakSet<object> => {
  const e = new WeakSet<object>();
  e.add(doc.getIn(["belt", 0]) as object);
  e.add(doc.getIn(["belt", 0, "steps", 0]) as object);
  return e;
};

describe("config-fields: referenced-file assist", () => {
  it("offers to create a missing config-sourced prompt_file, writing a contract-valid stub", () => {
    const repoDir = tmpRepoDir();
    const doc = stepDoc("config");
    let wrote: { abs: string; content: string } | null = null;
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: (abs, content) => { wrote = { abs, content }; } }), openBeltStep(doc), "belt");
    actionRun(fields, "+ create prompts/step.md (stub)");
    const w = wrote as { abs: string; content: string } | null;
    expect(w).not.toBeNull();
    expect(w!.abs).toBe(join(repoDir, "prompts/step.md"));
    // The stub must pass the prompt contract (no unrendered @@TOKEN@@ / malformed @@WHEN@@ of its own).
    expect(validatePromptBody(w!.content, { isActive: () => false, guardKinds: new Set() })).toEqual([]);
  });

  it("does NOT offer to create a prompt_file that already exists", () => {
    const repoDir = tmpRepoDir();
    mkdirSync(join(repoDir, "prompts"), { recursive: true });
    writeFileSync(join(repoDir, "prompts", "step.md"), "hi\n");
    const doc = stepDoc("config");
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: () => {} }), openBeltStep(doc), "belt");
    expect(fields.some((f) => f.kind === "action" && f.label.startsWith("+ create"))).toBe(false);
  });

  it("does NOT offer to create a repo-sourced prompt_file (it lives in the target checkout)", () => {
    const repoDir = tmpRepoDir();
    const doc = stepDoc("repo");
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: () => {} }), openBeltStep(doc), "belt");
    expect(fields.some((f) => f.kind === "action" && f.label.startsWith("+ create"))).toBe(false);
  });

  it("offers to create a missing match predicate with an `export default` stub", () => {
    const repoDir = tmpRepoDir();
    const doc = parseDocument(`work_sources: []\nbelt:\n  - name: b\n    source: s\n    match: match.ts\n    steps: [{ type: work }]\n`);
    const e = new WeakSet<object>();
    e.add(doc.getIn(["belt", 0]) as object);
    let wrote: { abs: string; content: string } | null = null;
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: (abs, content) => { wrote = { abs, content }; } }), e, "belt");
    actionRun(fields, "+ create match.ts (stub)");
    const w = wrote as { abs: string; content: string } | null;
    expect(w!.abs).toBe(join(repoDir, "match.ts"));
    expect(w!.content).toContain("export default");
  });

  it("makes no offer without a repoDir (no repo loaded)", () => {
    const doc = stepDoc("config");
    const fields = buildDescriptors(doc, () => {}, ctx(), openBeltStep(doc), "belt");
    expect(fields.some((f) => f.kind === "action" && f.label.startsWith("+ create"))).toBe(false);
  });
});

describe("config-fields: guidelines-prompt.md buffer", () => {
  it("offers a create action when the file is absent and editGuidelines is wired", () => {
    const repoDir = tmpRepoDir();
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    let opened = 0;
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, editGuidelines: () => { opened++; } }), new WeakSet(), "general");
    actionRun(fields, "+ create & edit guidelines-prompt.md");
    expect(opened).toBe(1);
  });

  it("shows an edit action when the file already exists", () => {
    const repoDir = tmpRepoDir();
    writeFileSync(join(repoDir, "guidelines-prompt.md"), "guidance\n");
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, editGuidelines: () => {} }), new WeakSet(), "general");
    expect(fields.some((f) => f.kind === "action" && f.label === "‹ edit guidelines-prompt.md ›")).toBe(true);
  });

  it("omits the guidelines section entirely without editGuidelines wiring", () => {
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const fields = buildDescriptors(doc, () => {}, ctx(), new WeakSet(), "general");
    expect(fields.some((f) => f.kind === "header" && f.label.startsWith("guidelines"))).toBe(false);
  });
});
