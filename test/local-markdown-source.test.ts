import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { LocalMarkdownSource } from "../src/clients/local-markdown-source.ts";
import { isLocalMarkdownItem } from "../src/types.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

function build(files: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "lm-"));
  tmps.push(folder);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(folder, name), body);
  const store = new Store(openDb(":memory:"), () => 1000);
  const src = new LocalMarkdownSource(folder, store, "r", "lm");
  return { folder, store, src };
}

describe("LocalMarkdownSource", () => {
  it("lists top-level *.md as todo, skipping dot- and __-prefixed files (single _ is allowed)", async () => {
    const { src } = build({
      "task-a.md": "# Alpha\n\nbody",
      "task-b.md": "do b",
      "_single.md": "# kept", // single underscore is fine now — only __ means "being prepared"
      "__draft.md": "# skip me", // __ prefix → ignored
      ".notes.md": "# hidden",
      "notes.txt": "not markdown",
    });
    const eligible = await src.listEligible();
    expect(eligible.map((t) => t.key).sort()).toEqual(["_single", "task-a", "task-b"]);
    expect(eligible.find((t) => t.key === "task-a")!.summary).toBe("Alpha"); // first H1
    expect(eligible.find((t) => t.key === "task-b")!.summary).toBe("task b"); // no H1 → humanized filename
  });

  it("exposes the local_markdown match context (path/filename/front-matter/body) for belt routing", async () => {
    const { src, folder } = build({ "idea-1.md": "---\ntype: research\n---\n# Idea\n\nthe body" });
    const item = (await src.listEligible()).find((t) => t.key === "idea-1")!;
    expect(item.sourceType).toBe("local_markdown");
    if (!isLocalMarkdownItem(item)) throw new Error("unreachable"); // narrow via the shipped guard, as user match.ts files do
    expect(item.filename).toBe("idea-1.md");
    expect(item.path).toBe(join(folder, "idea-1.md"));
    expect(item.frontMatter).toEqual({ type: "research" });
    expect(item.body).toContain("the body");
    expect(item.labels).toEqual([]); // uniform base field — no front-matter labels here
    expect(item.fields).toEqual({ type: "research" }); // fields = the front-matter object
  });

  it("skips items whose keys would break the unquoted step-done command / branch / evidence URL (INV-7)", async () => {
    const warnings: string[] = [];
    const folder = mkdtempSync(join(tmpdir(), "lm-"));
    tmps.push(folder);
    writeFileSync(join(folder, "ok-task.md"), "# fine");
    writeFileSync(join(folder, "My Task (v2).md"), "# spaces and parens");
    const store = new Store(openDb(":memory:"), () => 1000);
    const src = new LocalMarkdownSource(folder, store, "r", "lm", (_lvl, msg) => warnings.push(msg));
    expect((await src.listEligible()).map((t) => t.key)).toEqual(["ok-task"]);
    expect(warnings.some((w) => w.includes("My Task (v2).md"))).toBe(true);
  });

  it("surfaces front-matter labels on the uniform MatchItem base", async () => {
    const { src } = build({ "labeled.md": "---\nlabels: [bug, urgent]\n---\n# L" });
    const item = (await src.listEligible())[0]!;
    expect(item.labels).toEqual(["bug", "urgent"]);
  });

  it("ignores a __-prefixed top-level directory (work still being prepared)", async () => {
    const { src, folder } = build();
    mkdirSync(join(folder, "__wip"));
    writeFileSync(join(folder, "__wip", "spec.md"), "# Not ready");
    mkdirSync(join(folder, "ready"));
    writeFileSync(join(folder, "ready", "spec.md"), "# Ready to go");
    expect((await src.listEligible()).map((t) => t.key)).toEqual(["ready"]);
  });

  it("derives title/type from front-matter when present", async () => {
    const { src } = build({ "ticket.md": "---\ntitle: Custom Title\ntype: bug\n---\n# Heading\n\nbody" });
    const t = await src.describe("ticket");
    expect(t.summary).toBe("Custom Title");
    expect(t.type).toBe("bug");
  });

  it("falls back to humanized filename for a file with no heading or title", async () => {
    const { src } = build({ "improve-the-login-flow.md": "just some prose, no heading" });
    const t = await src.describe("improve-the-login-flow");
    expect(t.summary).toBe("improve the login flow"); // first prose line has no '# ' so → humanized stem
    expect(t.type).toBe("task"); // default
  });

  it("does not mistake a leading `---` thematic break for front-matter (keeps the real H1)", async () => {
    const body = ["---", "# Real Title", "", "intro prose", "---", "more"].join("\n");
    const { src } = build({ "doc.md": body });
    const t = await src.describe("doc");
    expect(t.summary).toBe("Real Title"); // not swallowed as front-matter
    expect(t.type).toBe("task");
  });

  it("ignores a `# ` line inside a fenced code block when deriving the title", async () => {
    const body = ["some intro, no real heading", "", "```sh", "# install deps", "npm i", "```"].join("\n");
    const { src } = build({ "setup-the-thing.md": body });
    const t = await src.describe("setup-the-thing");
    expect(t.summary).toBe("setup the thing"); // humanized filename, NOT the code comment
  });

  it("excludes items that are not todo (claimed / terminal) in work_items", async () => {
    const { src, store } = build({ "task-a.md": "# A", "task-b.md": "# B" });
    store.setWorkItemStatus("r", "lm", "task-a", "in_development");
    expect((await src.listEligible()).map((t) => t.key)).toEqual(["task-b"]);
    store.setWorkItemStatus("r", "lm", "task-b", "merged");
    expect(await src.listEligible()).toEqual([]); // both gone (one in-dev, one merged)
  });

  it("backstop: excludes a file that already has an active run (claim→in_development gap)", async () => {
    const { src, store } = build({ "task-a.md": "# A" });
    // run exists but the work_items row hasn't been written yet (still 'todo' by default)
    store.createRun({ repo: "r", workSource: "lm", belt: "gen", ticketKey: "task-a", branch: "feature/task-a" });
    expect(await src.listEligible()).toEqual([]); // not re-listed despite todo status
  });

  it("a merged file is never re-listed even with no active run", async () => {
    const { src, store } = build({ "task-a.md": "# A" });
    store.setWorkItemStatus("r", "lm", "task-a", "merged"); // terminal, no active run
    expect(await src.listEligible()).toEqual([]);
  });

  it("transition writes the lifecycle status (idempotent) and records metadata", async () => {
    const { src, store } = build({ "task-a.md": "---\ntitle: T\ntype: chore\n---\n# T" });
    expect(await src.transition("task-a", "in_development")).toEqual({ kind: "applied" });
    const wi = store.getWorkItem("r", "lm", "task-a")!;
    expect(wi.status).toBe("in_development");
    expect(wi.title).toBe("T");
    expect(wi.itemType).toBe("chore");
    expect(wi.path).toMatch(/task-a\.md$/);
    expect(await src.transition("task-a", "in_development")).toEqual({ kind: "noop" }); // idempotent no-op
    expect(await src.transition("task-a", "merged")).toEqual({ kind: "applied" }); // non-adjacent jump is fine
    expect(store.getWorkItem("r", "lm", "task-a")!.status).toBe("merged");
  });

  it("workDoc reflects what materialize wrote: task.md for a file item, task/ for a directory item", async () => {
    const { src, folder } = build({ "task-a.md": "# A" });
    const mem = join(folder, ".mem");
    mkdirSync(mem, { recursive: true });
    // Before materialize: sensible default (single-file layout).
    expect(await src.workDoc(mem)).toEqual({ path: "task.md", kind: "markdown file" });
    await src.materialize("task-a", mem, () => {});
    expect(await src.workDoc(mem)).toEqual({ path: "task.md", kind: "markdown file" });
    // A directory item → task/ layout.
    mkdirSync(join(folder, "feature-x"));
    writeFileSync(join(folder, "feature-x", "spec.md"), "# X");
    const mem2 = join(folder, ".mem2");
    mkdirSync(mem2, { recursive: true });
    await src.materialize("feature-x", mem2, () => {});
    expect(await src.workDoc(mem2)).toEqual({ path: "task/", kind: "directory of markdown files" });
  });

  it("materialize snapshots the file to task.md (idempotent), tolerates a missing file", async () => {
    const { src, folder } = build({ "task-a.md": "# A\n\nthe spec" });
    const mem = join(folder, ".mem");
    mkdirSync(mem, { recursive: true });
    await src.materialize("task-a", mem, () => {});
    expect(readFileSync(join(mem, "task.md"), "utf8")).toContain("the spec");
    // missing file → placeholder, no throw
    const mem2 = join(folder, ".mem2");
    mkdirSync(mem2, { recursive: true });
    await src.materialize("ghost", mem2, () => {});
    expect(readFileSync(join(mem2, "task.md"), "utf8")).toContain("not found");
  });

  it("lists a top-level directory holding a top-level *.md as a work item (key = dir name)", async () => {
    const { src, folder } = build({ "loose.md": "# Loose" });
    mkdirSync(join(folder, "feature-x"));
    writeFileSync(join(folder, "feature-x", "spec.md"), "# Build feature X\n\nthe brief");
    const eligible = await src.listEligible();
    expect(eligible.map((t) => t.key).sort()).toEqual(["feature-x", "loose"]);
    expect(eligible.find((t) => t.key === "feature-x")!.summary).toBe("Build feature X"); // first H1 of its md
  });

  it("seeds a directory ticket's title/type from README.md, else the first *.md", async () => {
    const { src, folder } = build();
    // README wins even though aaa.md sorts first.
    mkdirSync(join(folder, "with-readme"));
    writeFileSync(join(folder, "with-readme", "aaa.md"), "# Not this one");
    writeFileSync(join(folder, "with-readme", "README.md"), "---\ntitle: From Readme\ntype: bug\n---\n# x");
    // No README → first *.md alphabetically.
    mkdirSync(join(folder, "no-readme"));
    writeFileSync(join(folder, "no-readme", "zeta.md"), "# Zeta");
    writeFileSync(join(folder, "no-readme", "alpha.md"), "# Alpha first");
    const a = await src.describe("with-readme");
    expect(a.summary).toBe("From Readme");
    expect(a.type).toBe("bug");
    const b = await src.describe("no-readme");
    expect(b.summary).toBe("Alpha first");
    expect(b.type).toBe("task"); // default
  });

  it("only checks the directory's TOP level — markdown nested deeper does not qualify it", async () => {
    const { src, folder } = build();
    mkdirSync(join(folder, "nested-only", "docs"), { recursive: true });
    writeFileSync(join(folder, "nested-only", "docs", "spec.md"), "# Buried");
    mkdirSync(join(folder, "empty-dir"));
    writeFileSync(join(folder, "empty-dir", "notes.txt"), "no markdown here");
    expect(await src.listEligible()).toEqual([]); // neither qualifies
  });

  it("a <key>.md file wins a key collision with a <key>/ directory", async () => {
    const { src, folder } = build({ "dup.md": "# From the file" });
    mkdirSync(join(folder, "dup"));
    writeFileSync(join(folder, "dup", "spec.md"), "# From the dir");
    const eligible = await src.listEligible();
    expect(eligible.map((t) => t.key)).toEqual(["dup"]); // only one, and it's the file
    expect(eligible[0]!.summary).toBe("From the file");
    expect((await src.describe("dup")).summary).toBe("From the file");
  });

  it("materialize copies a whole directory item to task/ (idempotent, includes nested files)", async () => {
    const { src, folder } = build();
    mkdirSync(join(folder, "bundle", "assets"), { recursive: true });
    writeFileSync(join(folder, "bundle", "README.md"), "# Bundle\n\nthe spec");
    writeFileSync(join(folder, "bundle", "assets", "diagram.txt"), "shapes");
    const mem = join(folder, ".mem");
    mkdirSync(mem, { recursive: true });
    await src.materialize("bundle", mem, () => {});
    expect(existsSync(join(mem, "task.md"))).toBe(false); // a directory item does NOT use task.md
    expect(readFileSync(join(mem, "task", "README.md"), "utf8")).toContain("the spec");
    expect(readFileSync(join(mem, "task", "assets", "diagram.txt"), "utf8")).toBe("shapes"); // nested copied
    // idempotent: a second call with a now-empty source does not clobber the copy
    rmSync(join(folder, "bundle"), { recursive: true, force: true });
    await src.materialize("bundle", mem, () => {});
    expect(readFileSync(join(mem, "task", "README.md"), "utf8")).toContain("the spec");
  });

  it("health throws on a missing folder, passes on an existing one", async () => {
    const { src } = build();
    await expect(src.health()).resolves.toBeUndefined();
    const gone = new LocalMarkdownSource(join(tmpdir(), "definitely-not-here-xyz"), new Store(openDb(":memory:"), () => 1), "r", "lm");
    await expect(gone.health()).rejects.toThrow(/does not exist/);
  });
});
