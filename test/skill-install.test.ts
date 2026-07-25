// `herdr-factory skill install` — putting the shipped agent skill where a coding agent finds it. The
// core (installSkill) is filesystem- and HOME-parameterized, so most tests run against a synthetic
// bundle in a temp dir; a couple exercise the REAL shipped bundle so the import.meta.url resolution and
// the SKILL.md frontmatter stay honest.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, listSkillFiles, shippedSkillDir, skillDestination, SkillBundleMissingError, SkillDestinationExistsError, SKILL_NAME } from "../src/skill-install.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
});

/** A temp HOME plus a synthetic skill bundle (SKILL.md + a nested reference) to install from. */
function scaffold(): { skillDir: string; home: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "skill-install-test-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const skillDir = join(base, "bundle");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: herdr-factory\n---\nbody\n");
  writeFileSync(join(skillDir, "references", "cli.md"), "cli reference\n");
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  return { skillDir, home, base };
}

describe("skillDestination", () => {
  it("defaults to the agent home config", () => {
    expect(skillDestination({ home: "/h" })).toBe(join("/h", ".claude", "skills", SKILL_NAME));
  });

  it("--into targets a repo checkout's .claude/skills", () => {
    expect(skillDestination({ into: "/repo/app", home: "/h" })).toBe(join("/repo/app", ".claude", "skills", SKILL_NAME));
  });

  it("expands ~ in --into against the given home", () => {
    expect(skillDestination({ into: "~/dev/app", home: "/h" })).toBe(join("/h", "dev", "app", ".claude", "skills", SKILL_NAME));
  });
});

describe("listSkillFiles", () => {
  // Sorted by localeCompare (as prompts-eject does), which collates case-insensitively — hence
  // `references/…` before `SKILL.md`. The order is cosmetic; only determinism matters.
  it("enumerates every file recursively, POSIX-relative and sorted", () => {
    const { skillDir } = scaffold();
    expect(listSkillFiles(skillDir)).toEqual(["references/cli.md", "SKILL.md"]);
  });
});

describe("installSkill — home destination", () => {
  it("symlinks the bundle by default, so auto-update keeps the skill current", () => {
    const { skillDir, home } = scaffold();
    const res = installSkill({ skillDir, home });
    expect(res.mode).toBe("symlink");
    expect(res.action).toBe("installed");
    expect(res.files).toEqual([]);
    expect(lstatSync(res.dest).isSymbolicLink()).toBe(true);
    expect(realpathSync(res.dest)).toBe(realpathSync(skillDir));
    // Reachable through the link, which is the whole point.
    expect(readFileSync(join(res.dest, "references", "cli.md"), "utf8")).toBe("cli reference\n");
  });

  it("is idempotent: re-installing the same symlink reports `current` and needs no --force", () => {
    const { skillDir, home } = scaffold();
    installSkill({ skillDir, home });
    const res = installSkill({ skillDir, home });
    expect(res.action).toBe("current");
    expect(lstatSync(res.dest).isSymbolicLink()).toBe(true);
  });

  it("--copy writes real files instead of a link", () => {
    const { skillDir, home } = scaffold();
    const res = installSkill({ skillDir, home, mode: "copy" });
    expect(res.mode).toBe("copy");
    expect(res.files).toEqual(["references/cli.md", "SKILL.md"]);
    expect(lstatSync(res.dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(res.dest, "references", "cli.md"), "utf8")).toBe("cli reference\n");
  });
});

describe("installSkill — --into a repo checkout", () => {
  it("copies by default, so the bundle can be committed", () => {
    const { skillDir, home, base } = scaffold();
    const into = join(base, "target-repo");
    mkdirSync(into, { recursive: true });
    const res = installSkill({ skillDir, home, into });
    expect(res.mode).toBe("copy");
    expect(res.dest).toBe(join(into, ".claude", "skills", SKILL_NAME));
    expect(lstatSync(res.dest).isSymbolicLink()).toBe(false);
    expect(existsSync(join(res.dest, "SKILL.md"))).toBe(true);
  });

  it("--symlink overrides the copy default", () => {
    const { skillDir, home, base } = scaffold();
    const into = join(base, "target-repo");
    mkdirSync(into, { recursive: true });
    const res = installSkill({ skillDir, home, into, mode: "symlink" });
    expect(res.mode).toBe("symlink");
    expect(lstatSync(res.dest).isSymbolicLink()).toBe(true);
  });
});

describe("installSkill — clobber protection", () => {
  it("refuses an occupied destination without --force, naming what's in the way", () => {
    const { skillDir, home } = scaffold();
    const dest = skillDestination({ home });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "someone else's skill\n");
    try {
      installSkill({ skillDir, home });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillDestinationExistsError);
      expect((e as SkillDestinationExistsError).hint).toBe("an installed skill");
      expect((e as Error).message).toContain("--force");
    }
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("someone else's skill\n");
  });

  it("--force replaces a stale copy, and drops files the bundle no longer ships", () => {
    const { skillDir, home } = scaffold();
    const first = installSkill({ skillDir, home, mode: "copy" });
    // A reference file that used to exist upstream: a stale leftover would mislead an agent.
    writeFileSync(join(first.dest, "references", "removed-upstream.md"), "stale\n");
    const res = installSkill({ skillDir, home, mode: "copy", force: true });
    expect(res.action).toBe("replaced");
    expect(existsSync(join(res.dest, "references", "removed-upstream.md"))).toBe(false);
    expect(existsSync(join(res.dest, "SKILL.md"))).toBe(true);
  });

  it("--force re-points a symlink that targets an old checkout", () => {
    const { skillDir, home, base } = scaffold();
    const oldCheckout = join(base, "old-bundle");
    mkdirSync(oldCheckout, { recursive: true });
    writeFileSync(join(oldCheckout, "SKILL.md"), "old\n");
    const dest = skillDestination({ home });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(oldCheckout, dest, "dir");
    const res = installSkill({ skillDir, home, force: true });
    expect(res.action).toBe("replaced");
    expect(realpathSync(res.dest)).toBe(realpathSync(skillDir));
    // Replacing the LINK must never reach through it — the old checkout is someone's data.
    expect(readFileSync(join(oldCheckout, "SKILL.md"), "utf8")).toBe("old\n");
  });

  it("clears a DANGLING symlink (removed checkout) — existsSync would call it absent", () => {
    const { skillDir, home, base } = scaffold();
    const gone = join(base, "removed-checkout");
    const dest = skillDestination({ home });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(gone, dest, "dir");
    expect(existsSync(dest)).toBe(false); // follows the link into nothing
    // Occupied all the same: without --force we must not silently blow it away.
    expect(() => installSkill({ skillDir, home })).toThrow(SkillDestinationExistsError);
    const res = installSkill({ skillDir, home, force: true });
    expect(res.action).toBe("replaced");
    expect(readlinkSync(res.dest)).toBe(skillDir.replace(/\/$/, ""));
  });

  it("throws SkillBundleMissingError when the source has no SKILL.md", () => {
    const { home, base } = scaffold();
    const empty = join(base, "not-a-bundle");
    mkdirSync(empty, { recursive: true });
    expect(() => installSkill({ skillDir: empty, home })).toThrow(SkillBundleMissingError);
  });
});

describe("the real shipped bundle", () => {
  it("resolves to a directory holding SKILL.md and its references", () => {
    const dir = shippedSkillDir();
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    const files = listSkillFiles(dir);
    expect(files).toContain("SKILL.md");
    // The routing table in SKILL.md is only useful if the references it names actually ship.
    expect(files.filter((f) => f.startsWith("references/")).length).toBeGreaterThan(0);
  });

  it("SKILL.md carries frontmatter whose name matches the skill directory", () => {
    const body = readFileSync(join(shippedSkillDir(), "SKILL.md"), "utf8");
    expect(body.startsWith("---\n")).toBe(true);
    const frontmatter = body.slice(4, body.indexOf("\n---", 4));
    expect(frontmatter).toMatch(new RegExp(`^name:\\s*${SKILL_NAME}$`, "m"));
    expect(frontmatter).toMatch(/^description:\s*\S/m);
  });

  it("every references/ link in SKILL.md points at a file that ships", () => {
    const dir = shippedSkillDir();
    const body = readFileSync(join(dir, "SKILL.md"), "utf8");
    const linked = [...body.matchAll(/\((references\/[a-z0-9-]+\.md)\)/g)].flatMap((m) => m[1] ?? []);
    expect(linked.length).toBeGreaterThan(0);
    for (const rel of new Set(linked)) {
      expect(existsSync(join(dir, rel)), `SKILL.md links ${rel}, which does not ship`).toBe(true);
    }
  });
});
