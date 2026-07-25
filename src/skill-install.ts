// `herdr-factory skill install` — put the shipped agent skill (skills/herdr-factory/) where a coding
// agent will find it. The skill is the factory's AGENTIC interface: it walks a user through authoring a
// repo's config.yml, answers "how does this work", and diagnoses a wedged factory — so it only earns its
// keep if it's actually installed, and if it stays in lock-step with the engine it documents.
//
// Two destinations, two link modes, for that reason:
//   • the agent HOME config (`~/.claude/skills/herdr-factory`) — SYMLINKED into the running checkout by
//     default, so the auto-updater (which hard-resets the checkout) refreshes the skill for free. A copy
//     here would silently drift from the engine and start giving stale answers.
//   • a TARGET REPO (`--into <checkout>` → `<checkout>/.claude/skills/herdr-factory`) — COPIED by
//     default, because a checkout shared with a team must not contain a symlink into one machine's
//     ~/.local/share.
// Either default is overridable (`--copy` / `--symlink`).
//
// This module is the engine of the command (mirrors prompts-eject.ts / init.ts): a filesystem- and
// HOME-parameterized core so the destination, mode, clobber and refresh behavior are unit-testable, and
// the CLI wrapper (src/cli/index.ts) only parses flags and prints the result.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill directory name — also the skill's `name:` in SKILL.md, which is what an agent invokes. */
export const SKILL_NAME = "herdr-factory";

/** Where agent skills live under a config root (`~/.claude/skills/…`, `<repo>/.claude/skills/…`). */
const SKILLS_SUBPATH = [".claude", "skills"] as const;

/** Absolute path to the shipped skill bundle (`skills/herdr-factory/` at the checkout root). Resolved
 *  at runtime via import.meta.url — the same trick prompts-eject.ts's shippedPromptsDir uses — so it
 *  works both in a dev checkout and a vendored install (the whole tree ships; there is no build step). */
export function shippedSkillDir(): string {
  return fileURLToPath(new URL(`../skills/${SKILL_NAME}/`, import.meta.url));
}

/** How the destination points at the shipped bundle. `symlink` tracks the checkout (auto-update
 *  refreshes the skill); `copy` is a frozen snapshot you can commit. */
export type SkillInstallMode = "symlink" | "copy";

export interface SkillInstallOptions {
  /** Install into this repo checkout (`<into>/.claude/skills/herdr-factory`) instead of the agent home
   *  config. Default mode flips to `copy` — a committed checkout must not carry a machine-local symlink. */
  into?: string;
  /** Override the default mode (`symlink` for the home config, `copy` for `--into`). */
  mode?: SkillInstallMode;
  /** Replace a destination that already exists and doesn't match. Default: refuse, so a hand-edited or
   *  third-party `herdr-factory` skill is never silently destroyed. */
  force?: boolean;
  /** Override HOME (tests). Defaults to os.homedir(). */
  home?: string;
  /** Override the shipped bundle source (tests). Defaults to the real shipped dir. */
  skillDir?: string;
}

export type SkillInstallAction =
  /** Nothing was there; the skill was installed. */
  | "installed"
  /** Already installed the same way at the same source — nothing to do. */
  | "current"
  /** Something was there and `force` replaced it (a stale copy, or a symlink to an old checkout). */
  | "replaced";

export interface SkillInstallResult {
  /** The installed skill directory (or symlink), e.g. `~/.claude/skills/herdr-factory`. */
  dest: string;
  /** The shipped bundle the destination points at / was copied from. */
  source: string;
  mode: SkillInstallMode;
  action: SkillInstallAction;
  /** Files written, POSIX-relative to `dest` (e.g. `SKILL.md`, `references/config-reference.md`).
   *  Empty for a `symlink` install — there is exactly one link, and `dest` names it. */
  files: string[];
}

/** Raised when the destination is occupied by something we won't clobber without `--force`. `hint`
 *  describes what's in the way so the CLI can print an actionable message. */
export class SkillDestinationExistsError extends Error {
  readonly dest: string;
  readonly hint: string;
  constructor(dest: string, hint: string) {
    super(`${dest} already exists (${hint}) — pass --force to replace it`);
    this.name = "SkillDestinationExistsError";
    this.dest = dest;
    this.hint = hint;
  }
}

/** Raised when the shipped bundle isn't where it should be (a broken/partial install). */
export class SkillBundleMissingError extends Error {
  constructor(dir: string) {
    super(`the shipped skill bundle is missing (expected ${dir}/SKILL.md) — reinstall herdr-factory`);
    this.name = "SkillBundleMissingError";
  }
}

/** Every file in the shipped bundle, POSIX-relative to its root, sorted. Data-driven off the
 *  filesystem so a new reference file installs with no edit here. */
export function listSkillFiles(skillDir: string = shippedSkillDir()): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(skillDir, abs).split(sep).join("/"));
    }
  };
  walk(skillDir);
  return out.sort((a, b) => a.localeCompare(b));
}

/** Where the skill lands for the given options: the agent home config, or a target checkout. */
export function skillDestination(opts: Pick<SkillInstallOptions, "into" | "home"> = {}): string {
  const root = opts.into ? resolve(expandHome(opts.into, opts.home)) : (opts.home ?? homedir());
  return join(root, ...SKILLS_SUBPATH, SKILL_NAME);
}

/** `~`/`$HOME` expansion, matching how config.ts treats user-supplied paths. */
function expandHome(p: string, home?: string): string {
  const h = home ?? homedir();
  if (p === "~") return h;
  if (p.startsWith(`~${sep}`) || p.startsWith("~/")) return join(h, p.slice(2));
  if (p.startsWith("$HOME")) return join(h, p.slice("$HOME".length));
  return p;
}

/** True when `dest` is already a symlink resolving to `source` — an install that's current. */
function symlinkPointsAt(dest: string, source: string): boolean {
  try {
    if (!lstatSync(dest).isSymbolicLink()) return false;
    return realpathSync(dest) === realpathSync(source);
  } catch {
    // A dangling symlink (old checkout removed) resolves nowhere — not current, and safe to replace.
    return false;
  }
}

/** Describe what occupies `dest`, for the "pass --force" message. */
function occupantHint(dest: string): string {
  try {
    if (lstatSync(dest).isSymbolicLink()) return `a symlink to ${readlinkSync(dest)}`;
  } catch {
    return "unreadable";
  }
  return existsSync(join(dest, "SKILL.md")) ? "an installed skill" : "a directory";
}

/**
 * Install the shipped agent skill.
 *
 * Symlink mode replaces `dest` with a link to the shipped bundle (so the skill tracks the checkout).
 * Copy mode writes every bundle file under `dest`, removing a stale destination first so a reference
 * file deleted upstream doesn't linger and mislead an agent — which is why copy needs `force` to
 * overwrite at all, rather than eject's file-by-file skip: a doc bundle is only coherent whole.
 *
 * Pure of any console IO — returns what it did so the caller can report it.
 */
export function installSkill(opts: SkillInstallOptions = {}): SkillInstallResult {
  // resolve() both branches: shippedSkillDir() is URL-derived and carries a trailing slash, which would
  // otherwise make the printed source and the symlink's own target read differently.
  const source = resolve(opts.skillDir ?? shippedSkillDir());
  if (!existsSync(join(source, "SKILL.md"))) throw new SkillBundleMissingError(source);

  const mode: SkillInstallMode = opts.mode ?? (opts.into ? "copy" : "symlink");
  const dest = skillDestination(opts);
  const occupied = existsSync(dest) || isDanglingLink(dest);

  if (occupied && mode === "symlink" && symlinkPointsAt(dest, source)) {
    return { dest, source, mode, action: "current", files: [] };
  }
  if (occupied && !opts.force) throw new SkillDestinationExistsError(dest, occupantHint(dest));

  mkdirSync(dirname(dest), { recursive: true });
  if (occupied) rmSync(dest, { recursive: true, force: true });
  const action: SkillInstallAction = occupied ? "replaced" : "installed";

  if (mode === "symlink") {
    symlinkSync(source, dest, "dir");
    return { dest, source, mode, action, files: [] };
  }

  const files = listSkillFiles(source);
  for (const rel of files) {
    const to = join(dest, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(source, ...rel.split("/")), to);
  }
  return { dest, source, mode, action, files };
}

/** existsSync() follows symlinks, so a link into a removed checkout reads as absent — but it still
 *  occupies the path and must be cleared before we can write there. */
function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
