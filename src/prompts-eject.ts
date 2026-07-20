// `herdr-factory prompts eject` — copy the SHIPPED prompt pack into a repo's config folder so you
// can read and customize it. The engine ships each step's prompt inside the package (src/prompts/,
// resolved at runtime by config.ts's shippedPrompt); this makes a local, editable copy under
// `repos/<name>/prompts/` — the `prompt_file_source: config` root — which a belt step then points a
// `prompt_file:` at (see README "Prompts"). It's COPY-ONLY: it never edits config.yml (the belt
// pipeline stays declarative), it just prints the `prompt_file:` lines to paste. Existing files are
// preserved unless `--force`, so re-ejecting never clobbers your edits.
//
// This module is the engine of the command (mirrors init.ts's split): a filesystem-parameterized
// core so the copy/skip/force/step behavior is unit-testable, and the CLI wrapper (src/cli/index.ts)
// only parses flags and prints the result.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the shipped prompt pack (src/prompts/). Resolved at runtime via import.meta.url
 *  — the same trick config.ts's shippedPrompt uses — so it works both in a dev checkout and a
 *  vendored install (the whole `src/` ships; there is no build step). */
export function shippedPromptsDir(): string {
  return fileURLToPath(new URL("prompts/", import.meta.url));
}

/** One prompt in the shipped pack. `rel` is POSIX-relative to the pack root (`work.md`,
 *  `jira/work.md`); `slug` is the basename without `.md` (the step/prompt name a `--step` filter
 *  matches); `source` is the per-source subfolder (`jira`) or undefined for a shared prompt. */
export interface PromptPackEntry {
  rel: string;
  slug: string;
  source?: string;
}

/** Enumerate the shipped prompt pack: every `*.md` under the pack dir, recursively, sorted by `rel`.
 *  Data-driven off the filesystem (not a hard-coded list) so a new shipped prompt is ejected with no
 *  edit here. */
export function listShippedPrompts(packDir: string = shippedPromptsDir()): PromptPackEntry[] {
  const out: PromptPackEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(packDir, abs).split(sep).join("/");
        const parts = rel.split("/");
        out.push({ rel, slug: basename(entry.name, ".md"), source: parts.length > 1 ? parts[0] : undefined });
      }
    }
  };
  walk(packDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Raised when `--step <name>` names no prompt in the pack; carries the available slugs for a
 *  helpful CLI message. */
export class UnknownPromptStepError extends Error {
  readonly step: string;
  readonly available: string[];
  constructor(step: string, available: string[]) {
    super(`no shipped prompt named "${step}" — available: ${available.join(", ")}`);
    this.name = "UnknownPromptStepError";
    this.step = step;
    this.available = available;
  }
}

export interface EjectOptions {
  /** The repo's config folder (`~/.config/herdr-factory/repos/<name>/`). Prompts land under
   *  `prompts/` beneath it — the path a `prompt_file` (source `config`) is resolved against. */
  repoConfigDir: string;
  /** Eject only the prompt(s) with this slug (`work`/`review`/`pr`/`evidence`/`resolver`), including
   *  every per-source variant of it; undefined ⇒ the whole pack. */
  step?: string;
  /** Overwrite prompts already present in the destination. Default: skip them, so a re-eject never
   *  clobbers your edits. */
  force?: boolean;
  /** Override the shipped pack source (tests). Defaults to the real shipped dir. */
  packDir?: string;
}

/** One file eject decided on. `configRel` is the path a step's `prompt_file:` references (relative to
 *  the config folder, POSIX), e.g. `prompts/work.md`. */
export interface EjectedFile {
  entry: PromptPackEntry;
  configRel: string;
  dest: string;
}

export interface EjectResult {
  /** `<repoConfigDir>/prompts`. */
  destRoot: string;
  written: EjectedFile[];
  /** Already present in the destination and left untouched (no `--force`). */
  skipped: EjectedFile[];
  /** Distinct prompt slugs the pack offers (for `--step` discovery / errors). */
  availableSlugs: string[];
}

/** Copy the shipped prompt pack (or one `--step`) into `<repoConfigDir>/prompts/`, preserving the
 *  per-source subfolder layout. Never overwrites an existing destination file unless `force`. Pure
 *  of any console IO — returns what it did so the caller can report it. */
export function ejectPrompts(opts: EjectOptions): EjectResult {
  const packDir = opts.packDir ?? shippedPromptsDir();
  const all = listShippedPrompts(packDir);
  const availableSlugs = [...new Set(all.map((e) => e.slug))].sort();

  let selected = all;
  if (opts.step !== undefined) {
    selected = all.filter((e) => e.slug === opts.step);
    if (selected.length === 0) throw new UnknownPromptStepError(opts.step, availableSlugs);
  }

  const destRoot = join(opts.repoConfigDir, "prompts");
  const written: EjectedFile[] = [];
  const skipped: EjectedFile[] = [];
  for (const entry of selected) {
    const segments = entry.rel.split("/");
    const dest = join(destRoot, ...segments);
    const file: EjectedFile = { entry, configRel: `prompts/${entry.rel}`, dest };
    if (existsSync(dest) && !opts.force) {
      skipped.push(file);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(packDir, ...segments), dest);
    written.push(file);
  }
  return { destRoot, written, skipped, availableSlugs };
}
