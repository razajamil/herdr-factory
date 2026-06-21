import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Store } from "../db/store.ts";
import type { Logger, WorkSource } from "../core/deps.ts";
import type { Ticket, WorkState } from "../types.ts";

/** Split optional YAML front-matter (`--- … ---`) off the head of a markdown doc. Only consumes
 *  the block when it parses to a YAML object — so a leading `---` thematic break (a horizontal
 *  rule, common in prose) is left in the body rather than being mistaken for front-matter and
 *  silently swallowing the real heading. */
function splitFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: content };
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1]!);
  } catch {
    return { data: {}, body: content }; // malformed → treat the whole thing as body
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: {}, body: content }; // not real front-matter (e.g. a `---` thematic break)
  }
  return { data: parsed as Record<string, unknown>, body: content.slice(m[0].length) };
}

/** The first `# H1` heading, skipping fenced code blocks (``` / ~~~) so a `# comment` inside a
 *  code sample isn't mistaken for the doc title. */
function firstHeading(body: string): string | null {
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

function humanize(stem: string): string {
  return stem.replace(/[-_]+/g, " ").trim();
}

/** Derive a Ticket (key/summary/type) from a markdown file's key + contents. Title comes from
 *  front-matter `title`, else the first H1, else the humanised filename. Type from front-matter
 *  `type`, else "task". */
function deriveTicket(key: string, content: string): Ticket {
  const { data, body } = splitFrontmatter(content);
  const fmTitle = typeof data.title === "string" ? data.title.trim() : "";
  const fmType = typeof data.type === "string" ? data.type.trim() : "";
  const summary = fmTitle || firstHeading(body) || humanize(key) || key;
  const type = fmType || "task";
  return { key, summary, type };
}

/**
 * A folder of `*.md` files as a work source. herdr-factory owns the status of record here — the
 * lifecycle (todo → in_development → in_review → merged|aborted) is tracked in the `work_items`
 * table, NOT in the files (which are never modified). A file's key is its filename without `.md`;
 * the live file is snapshotted to `task.md` at materialize time and not re-read afterwards.
 *
 * Only top-level `*.md` files are scanned; dotfiles and `_`-prefixed files are skipped (so notes
 * / templates / `_drafts.md` don't get claimed as work).
 */
export class LocalMarkdownSource implements WorkSource {
  private readonly folder: string;
  private readonly store: Store;
  private readonly repo: string;
  private readonly name: string;
  constructor(folder: string, store: Store, repo: string, name: string) {
    this.folder = folder;
    this.store = store;
    this.repo = repo;
    this.name = name;
  }

  private fileFor(key: string): string {
    return join(this.folder, `${key}.md`);
  }

  async listEligible(): Promise<Ticket[]> {
    if (!existsSync(this.folder)) return []; // missing folder = no work (doctor's health() flags it)
    let names: string[];
    try {
      names = readdirSync(this.folder);
    } catch {
      return [];
    }
    const out: Ticket[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".md") || name.startsWith(".") || name.startsWith("_")) continue;
      const full = join(this.folder, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const key = name.slice(0, -3); // strip ".md"
      const status = this.store.getWorkItem(this.repo, this.name, key)?.status ?? "todo";
      if (status !== "todo") continue; // claimed earlier or terminal (merged/aborted)
      // Backstop: never list an item that already has an active run (covers the window between
      // claim and the in_development write, and any stale work_items row).
      if (this.store.activeRunForTicket(this.repo, this.name, key)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      out.push(deriveTicket(key, content));
    }
    return out;
  }

  async describe(key: string): Promise<Ticket> {
    const p = this.fileFor(key);
    if (!existsSync(p)) throw new Error(`local_markdown: no file for "${key}" at ${p}`);
    return deriveTicket(key, readFileSync(p, "utf8"));
  }

  /** Best-effort metadata for an item's work_items row (null fields when the file is gone). */
  private metaFor(key: string): { title?: string | null; itemType?: string | null; path?: string | null } {
    const p = this.fileFor(key);
    if (!existsSync(p)) return { path: p };
    try {
      const t = deriveTicket(key, readFileSync(p, "utf8"));
      return { title: t.summary, itemType: t.type, path: p };
    } catch {
      return { path: p };
    }
  }

  async transition(key: string, to: WorkState): Promise<boolean> {
    // Tolerant idempotent upsert — any state → any state, no-op (false) if already there.
    return this.store.setWorkItemStatus(this.repo, this.name, key, to, this.metaFor(key));
  }

  async materialize(key: string, memDir: string, log: Logger): Promise<void> {
    const dest = join(memDir, "task.md");
    if (existsSync(dest)) return; // idempotent across claiming ticks
    const src = this.fileFor(key);
    if (!existsSync(src)) {
      writeFileSync(dest, `# ${key}\n\n_(source markdown file ${src} was not found at materialize time)_\n`);
      log("warn", `${key}: local_markdown source file missing at ${src}`);
      return;
    }
    writeFileSync(dest, readFileSync(src, "utf8"));
  }

  async health(): Promise<void> {
    if (!existsSync(this.folder)) throw new Error(`local_markdown folder does not exist: ${this.folder}`);
    if (!statSync(this.folder).isDirectory()) {
      throw new Error(`local_markdown folder is not a directory: ${this.folder}`);
    }
  }
}
