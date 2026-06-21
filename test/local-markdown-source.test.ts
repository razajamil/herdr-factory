import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { LocalMarkdownSource } from "../src/clients/local-markdown-source.ts";

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
  it("lists top-level *.md as todo, skipping dot/underscore files", async () => {
    const { src } = build({
      "task-a.md": "# Alpha\n\nbody",
      "task-b.md": "do b",
      "_draft.md": "# skip me",
      ".notes.md": "# hidden",
      "notes.txt": "not markdown",
    });
    const eligible = await src.listEligible();
    expect(eligible.map((t) => t.key).sort()).toEqual(["task-a", "task-b"]);
    expect(eligible.find((t) => t.key === "task-a")!.summary).toBe("Alpha"); // first H1
    expect(eligible.find((t) => t.key === "task-b")!.summary).toBe("task b"); // no H1 → humanized filename
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
    store.createRun({ repo: "r", workSource: "lm", ticketKey: "task-a", branch: "feature/task-a" });
    expect(await src.listEligible()).toEqual([]); // not re-listed despite todo status
  });

  it("a merged file is never re-listed even with no active run", async () => {
    const { src, store } = build({ "task-a.md": "# A" });
    store.setWorkItemStatus("r", "lm", "task-a", "merged"); // terminal, no active run
    expect(await src.listEligible()).toEqual([]);
  });

  it("transition writes the lifecycle status (idempotent) and records metadata", async () => {
    const { src, store } = build({ "task-a.md": "---\ntitle: T\ntype: chore\n---\n# T" });
    expect(await src.transition("task-a", "in_development")).toBe(true);
    let wi = store.getWorkItem("r", "lm", "task-a")!;
    expect(wi.status).toBe("in_development");
    expect(wi.title).toBe("T");
    expect(wi.itemType).toBe("chore");
    expect(wi.path).toMatch(/task-a\.md$/);
    expect(await src.transition("task-a", "in_development")).toBe(false); // idempotent no-op
    expect(await src.transition("task-a", "merged")).toBe(true); // non-adjacent jump is fine
    expect(store.getWorkItem("r", "lm", "task-a")!.status).toBe("merged");
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

  it("health throws on a missing folder, passes on an existing one", async () => {
    const { src } = build();
    await expect(src.health()).resolves.toBeUndefined();
    const gone = new LocalMarkdownSource(join(tmpdir(), "definitely-not-here-xyz"), new Store(openDb(":memory:"), () => 1), "r", "lm");
    await expect(gone.health()).rejects.toThrow(/does not exist/);
  });
});
