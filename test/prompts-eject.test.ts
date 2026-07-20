// `herdr-factory prompts eject` — copying the shipped prompt pack into a repo's config folder. The
// core (ejectPrompts) is filesystem-parameterized, so most tests run against a synthetic pack in a
// temp dir; a couple exercise the REAL shipped pack so the import.meta.url resolution + step wiring
// stay honest.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectPrompts, listShippedPrompts, shippedPromptsDir, UnknownPromptStepError } from "../src/prompts-eject.ts";
import { stepDescriptorFor } from "../src/steps/registry.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
});

/** A temp dir with a synthetic prompt pack (shared + a per-source variant) and a fresh repo config
 *  dir to eject into. */
function scaffold(): { packDir: string; repoConfigDir: string } {
  const base = mkdtempSync(join(tmpdir(), "eject-test-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const packDir = join(base, "pack");
  mkdirSync(join(packDir, "jira"), { recursive: true });
  writeFileSync(join(packDir, "work.md"), "shared work prompt\n");
  writeFileSync(join(packDir, "review.md"), "shared review prompt\n");
  writeFileSync(join(packDir, "jira", "work.md"), "jira work prompt\n");
  writeFileSync(join(packDir, "resolver.md"), "resolver prompt\n");
  const repoConfigDir = join(base, "repo");
  mkdirSync(repoConfigDir, { recursive: true });
  return { packDir, repoConfigDir };
}

describe("listShippedPrompts", () => {
  it("enumerates every *.md recursively with slug + per-source folder", () => {
    const { packDir } = scaffold();
    const entries = listShippedPrompts(packDir);
    expect(entries.map((e) => e.rel)).toEqual(["jira/work.md", "resolver.md", "review.md", "work.md"]);
    expect(entries.find((e) => e.rel === "jira/work.md")).toMatchObject({ slug: "work", source: "jira" });
    expect(entries.find((e) => e.rel === "work.md")).toMatchObject({ slug: "work", source: undefined });
  });
});

describe("ejectPrompts", () => {
  it("copies the whole pack into <repoConfigDir>/prompts, preserving per-source layout", () => {
    const { packDir, repoConfigDir } = scaffold();
    const res = ejectPrompts({ repoConfigDir, packDir });
    expect(res.written.map((f) => f.configRel).sort()).toEqual(["prompts/jira/work.md", "prompts/resolver.md", "prompts/review.md", "prompts/work.md"]);
    expect(res.skipped).toHaveLength(0);
    expect(readFileSync(join(repoConfigDir, "prompts", "work.md"), "utf8")).toBe("shared work prompt\n");
    expect(readFileSync(join(repoConfigDir, "prompts", "jira", "work.md"), "utf8")).toBe("jira work prompt\n");
    expect(res.destRoot).toBe(join(repoConfigDir, "prompts"));
    expect(res.availableSlugs).toEqual(["resolver", "review", "work"]);
  });

  it("skips files that already exist (no --force), preserving edits", () => {
    const { packDir, repoConfigDir } = scaffold();
    ejectPrompts({ repoConfigDir, packDir });
    // Edit an ejected copy, then re-eject: it must be left untouched and reported as skipped.
    const edited = join(repoConfigDir, "prompts", "work.md");
    writeFileSync(edited, "MY EDITS\n");
    const res = ejectPrompts({ repoConfigDir, packDir });
    expect(res.written).toHaveLength(0);
    expect(res.skipped.map((f) => f.configRel)).toContain("prompts/work.md");
    expect(readFileSync(edited, "utf8")).toBe("MY EDITS\n");
  });

  it("--force overwrites existing files", () => {
    const { packDir, repoConfigDir } = scaffold();
    ejectPrompts({ repoConfigDir, packDir });
    const edited = join(repoConfigDir, "prompts", "work.md");
    writeFileSync(edited, "MY EDITS\n");
    const res = ejectPrompts({ repoConfigDir, packDir, force: true });
    expect(res.skipped).toHaveLength(0);
    expect(res.written.map((f) => f.configRel)).toContain("prompts/work.md");
    expect(readFileSync(edited, "utf8")).toBe("shared work prompt\n");
  });

  it("--step ejects one slug plus every per-source variant of it", () => {
    const { packDir, repoConfigDir } = scaffold();
    const res = ejectPrompts({ repoConfigDir, packDir, step: "work" });
    expect(res.written.map((f) => f.configRel).sort()).toEqual(["prompts/jira/work.md", "prompts/work.md"]);
    expect(existsSync(join(repoConfigDir, "prompts", "review.md"))).toBe(false);
  });

  it("throws UnknownPromptStepError (with available slugs) for an unknown --step", () => {
    const { packDir, repoConfigDir } = scaffold();
    try {
      ejectPrompts({ repoConfigDir, packDir, step: "bogus" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownPromptStepError);
      expect((e as UnknownPromptStepError).available).toEqual(["resolver", "review", "work"]);
    }
  });
});

describe("the real shipped pack", () => {
  it("resolves to a directory that contains the built-in step prompts", () => {
    const entries = listShippedPrompts(shippedPromptsDir());
    const slugs = new Set(entries.map((e) => e.slug));
    // Every built-in step that ships a base prompt must be present in the pack.
    for (const slug of ["work", "review", "pr", "evidence"]) {
      expect(slugs.has(slug), `shipped pack is missing ${slug}.md`).toBe(true);
      expect(stepDescriptorFor(slug)?.basePrompt?.slug).toBe(slug);
    }
    expect(slugs.has("resolver")).toBe(true);
  });
});
