import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_PACK_SUBDIR,
  REPO_PACK_SUBDIR,
  SHIPPED_PROMPTS_DIR,
  packLayers,
  resolvePromptFile,
} from "../src/prompt-packs.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});

/** A temp pack dir with a set of `relpath -> body` files written into it. */
function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-"));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

describe("prompt-packs — the repo-level prompt-resolution chain", () => {
  it("falls back to the engine's shipped prompt when no override layer has the slug", () => {
    const hit = resolvePromptFile([SHIPPED_PROMPTS_DIR], "jira", "work", true);
    expect(hit).toBeDefined();
    expect(hit!.path).toContain("work.md");
    expect(hit!.body.length).toBeGreaterThan(0);
  });

  it("a config-folder pack overrides the shipped base", () => {
    const config = pack({ "work.md": "CONFIG work base" });
    const hit = resolvePromptFile([config, SHIPPED_PROMPTS_DIR], "jira", "work", true);
    expect(hit!.body).toBe("CONFIG work base");
  });

  it("precedence: repo checkout ▸ config folder ▸ shipped (first found wins)", () => {
    const repo = pack({ "review.md": "REPO review" });
    const config = pack({ "review.md": "CONFIG review" });
    // full chain — repo wins
    expect(resolvePromptFile([repo, config, SHIPPED_PROMPTS_DIR], "jira", "review", true)!.body).toBe("REPO review");
    // drop the repo layer — config wins
    expect(resolvePromptFile([config, SHIPPED_PROMPTS_DIR], "jira", "review", true)!.body).toBe("CONFIG review");
    // drop both user layers — shipped wins (and it's the real shipped review prompt)
    expect(resolvePromptFile([SHIPPED_PROMPTS_DIR], "jira", "review", true)!.body).toContain("fresh-eyes");
  });

  it("within a layer the per-source-typed file beats the shared one (when perSourceOverride)", () => {
    const dir = pack({ "work.md": "SHARED work", "jira/work.md": "JIRA work" });
    expect(resolvePromptFile([dir, SHIPPED_PROMPTS_DIR], "jira", "work", true)!.body).toBe("JIRA work");
    // a different source type falls through to the shared file in the same layer
    expect(resolvePromptFile([dir, SHIPPED_PROMPTS_DIR], "github_issues", "work", true)!.body).toBe("SHARED work");
  });

  it("perSourceOverride=false ignores the typed variant and uses the shared file", () => {
    const dir = pack({ "work.md": "SHARED work", "jira/work.md": "JIRA work" });
    expect(resolvePromptFile([dir, SHIPPED_PROMPTS_DIR], "jira", "work", false)!.body).toBe("SHARED work");
  });

  it("returns undefined when none of the given dirs has the slug (no shipped fallback passed)", () => {
    const empty = pack({});
    expect(resolvePromptFile([empty], "jira", "work", true)).toBeUndefined();
  });

  it("packLayers orders repo-checkout above the config folder, and drops the repo layer with no worktree", () => {
    expect(packLayers("/wt", "/cfg")).toEqual([join("/wt", REPO_PACK_SUBDIR), join("/cfg", CONFIG_PACK_SUBDIR)]);
    expect(packLayers(undefined, "/cfg")).toEqual([join("/cfg", CONFIG_PACK_SUBDIR)]);
  });
});
