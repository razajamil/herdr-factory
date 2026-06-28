import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Store } from "../db/store.ts";
import type { Logger, WorkSource } from "../core/deps.ts";
import type { HumanAskInput, HumanAskResult, HumanPollInput, HumanReply, MatchItem, Ticket, WorkState } from "../types.ts";

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

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
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
 * A folder of work items as a work source. Each top-level item is either a single `*.md` file OR
 * a top-level directory that contains at least one top-level `*.md` (only that directory's own
 * level is checked — markdown nested deeper does not qualify it). herdr-factory owns the status of
 * record here — the lifecycle (todo → in_development → in_review → merged|aborted) is tracked in
 * the `work_items` table, NOT in the source markdown. Human questions may create a separate
 * `.herdr-factory-human/` inbox under the source folder.
 *
 * An item's key is its filename without `.md` (file) or its directory name (directory); a
 * `<key>.md` file wins a collision with a `<key>/` directory. At materialize time a file is
 * snapshotted to `task.md` and a directory is copied whole to `task/`, and not re-read afterwards.
 * A directory's ticket title/type are seeded from its primary markdown (`README.md` if present,
 * else the first `*.md` alphabetically).
 *
 * Only top-level entries are scanned; dot-prefixed names (hidden/system) and `__`-prefixed names
 * are skipped — a `__` prefix marks work still being prepared (so `__drafts.md` / a `__wip/`
 * directory don't get claimed until renamed).
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

  /** Top-level `*.md` in a work directory whose contents seed the ticket: `README.md`
   *  (case-insensitive) if present, else the first `*.md` alphabetically. Null when the directory
   *  has no top-level markdown (so it does not qualify as a work item). */
  private primaryMd(dir: string): string | null {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const mds = ents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => d.name)
      .sort();
    if (mds.length === 0) return null;
    const readme = mds.find((n) => n.toLowerCase() === "readme.md");
    return join(dir, readme ?? mds[0]!);
  }

  /** Resolve a key to its on-disk source: a top-level `<key>.md` file, or a top-level `<key>/`
   *  directory holding at least one top-level `*.md`. Files win a name collision. The `missing`
   *  path points at the expected `.md` (used for the materialize placeholder + warning). */
  private resolve(key: string): { kind: "file" | "dir" | "missing"; path: string } {
    const file = join(this.folder, `${key}.md`);
    try {
      if (statSync(file).isFile()) return { kind: "file", path: file };
    } catch {
      /* not a file — try a directory */
    }
    const dir = join(this.folder, key);
    try {
      if (statSync(dir).isDirectory() && this.primaryMd(dir)) return { kind: "dir", path: dir };
    } catch {
      /* not a directory either */
    }
    return { kind: "missing", path: file };
  }

  /** The markdown that seeds the ticket for a resolved item — the file itself, or the directory's
   *  primary `*.md`. Throws on a missing/unreadable item. */
  private readSpec(r: { kind: "file" | "dir" | "missing"; path: string }): string {
    if (r.kind === "file") return readFileSync(r.path, "utf8");
    if (r.kind === "dir") return readFileSync(this.primaryMd(r.path)!, "utf8");
    throw new Error(`local_markdown: no source at ${r.path}`);
  }

  async listEligible(): Promise<MatchItem[]> {
    if (!existsSync(this.folder)) return []; // missing folder = no work (doctor's health() flags it)
    let names: string[];
    try {
      names = readdirSync(this.folder);
    } catch {
      return [];
    }
    // A `<key>.md` file always wins a key collision with a `<key>/` directory, so collect the
    // file keys up front and let directories defer to them.
    const fileKeys = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".md") || name.startsWith(".") || name.startsWith("__")) continue;
      try {
        if (statSync(join(this.folder, name)).isFile()) fileKeys.add(name.slice(0, -3));
      } catch {
        /* unreadable — ignore */
      }
    }
    const out: MatchItem[] = [];
    for (const name of names.sort()) {
      if (name.startsWith(".") || name.startsWith("__")) continue; // hidden, or `__`-prefixed = being prepared
      const full = join(this.folder, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      let key: string;
      if (st.isFile() && name.endsWith(".md")) {
        key = name.slice(0, -3); // strip ".md"
      } else if (st.isDirectory()) {
        key = name;
        if (fileKeys.has(key)) continue; // a sibling <key>.md already owns this key
        if (!this.primaryMd(full)) continue; // no top-level *.md → not a work item
      } else {
        continue; // a non-markdown file, or something exotic
      }
      const status = this.store.getWorkItem(this.repo, this.name, key)?.status ?? "todo";
      if (status !== "todo") continue; // claimed earlier or terminal (merged/aborted)
      // Backstop: never list an item that already has an active run (covers the window between
      // claim and the in_development write, and any stale work_items row).
      if (this.store.activeRunForTicket(this.repo, this.name, key)) continue;
      let spec: string; // the markdown whose contents seed this ticket
      try {
        spec = st.isDirectory() ? readFileSync(this.primaryMd(full)!, "utf8") : readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const ticket = deriveTicket(key, spec); // for summary/type
      const { data: frontMatter, body } = splitFrontmatter(spec);
      out.push({ sourceType: "local_markdown", key, summary: ticket.summary, type: ticket.type, path: full, filename: name, frontMatter, body });
    }
    return out;
  }

  async describe(key: string): Promise<Ticket> {
    const r = this.resolve(key);
    if (r.kind === "missing") throw new Error(`local_markdown: no file or directory for "${key}" at ${r.path}`);
    return deriveTicket(key, this.readSpec(r));
  }

  /** Best-effort metadata for an item's work_items row (null fields when the source is gone).
   *  `path` is the `.md` file or the directory itself. */
  private metaFor(key: string): { title?: string | null; itemType?: string | null; path?: string | null } {
    const r = this.resolve(key);
    if (r.kind === "missing") return { path: r.path };
    try {
      const t = deriveTicket(key, this.readSpec(r));
      return { title: t.summary, itemType: t.type, path: r.path };
    } catch {
      return { path: r.path };
    }
  }

  async transition(key: string, to: WorkState): Promise<boolean> {
    // Tolerant idempotent upsert — any state → any state, no-op (false) if already there.
    return this.store.setWorkItemStatus(this.repo, this.name, key, to, this.metaFor(key));
  }

  async materialize(key: string, memDir: string, log: Logger): Promise<void> {
    const r = this.resolve(key);
    // A directory item: copy the whole tree to task/ (so the agent sees every file, nested
    // included). Idempotent on the task/ dir's existence across claiming ticks.
    if (r.kind === "dir") {
      const dest = join(memDir, "task");
      if (existsSync(dest)) return;
      cpSync(r.path, dest, { recursive: true });
      return;
    }
    // A single-file item (or a missing source): snapshot to task.md.
    const dest = join(memDir, "task.md");
    if (existsSync(dest)) return; // idempotent across claiming ticks
    if (r.kind === "missing") {
      writeFileSync(dest, `# ${key}\n\n_(source markdown for "${key}" was not found at materialize time)_\n`);
      log("warn", `${key}: local_markdown source not found (looked for ${r.path})`);
      return;
    }
    writeFileSync(dest, readFileSync(r.path, "utf8"));
  }

  private humanQuestionPath(key: string, questionId: number): string {
    return join(this.folder, ".herdr-factory-human", `${safeName(key)}-q${questionId}.md`);
  }

  async askHuman(input: HumanAskInput): Promise<HumanAskResult> {
    const file = this.humanQuestionPath(input.key, input.questionId);
    mkdirSync(join(this.folder, ".herdr-factory-human"), { recursive: true });
    if (!existsSync(file)) {
      writeFileSync(
        file,
        [
          `# Human question for ${input.key}`,
          "",
          `Run: ${input.repo}/${input.runId}`,
          `Step: ${input.step ?? "unknown"}`,
          "",
          "## Question",
          "",
          input.question.trim(),
          "",
          "## Answer",
          "",
          "_Write the answer below this line. herdr-factory resumes automatically once this section is non-empty._",
          "",
        ].join("\n"),
      );
    }
    return { externalId: file, externalCreatedAt: null };
  }

  async pollHumanReply(input: HumanPollInput): Promise<HumanReply | null> {
    const file = input.externalId || this.humanQuestionPath(input.key, input.questionId);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const marker = "## Answer";
    const i = text.indexOf(marker);
    if (i < 0) return null;
    const answer = text
      .slice(i + marker.length)
      .replace(/_Write the answer below this line[\s\S]*?_/, "")
      .trim();
    if (!answer) return null;
    return { body: answer, externalId: file, externalCreatedAt: null, author: "local_markdown" };
  }

  async health(): Promise<void> {
    if (!existsSync(this.folder)) throw new Error(`local_markdown folder does not exist: ${this.folder}`);
    if (!statSync(this.folder).isDirectory()) {
      throw new Error(`local_markdown folder is not a directory: ${this.folder}`);
    }
  }
}
