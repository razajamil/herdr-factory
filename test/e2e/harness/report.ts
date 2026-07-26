// Renders an e2e run's artifacts directory into a human-readable summary.md.
//
// Inputs are whatever the run happened to leave behind:
//   <artifacts>/results.json            vitest's json reporter (the authoritative pass/fail list)
//   <artifacts>/scenarios/<name>/…      per-scenario post-mortem material the harness writes
//                                       (the SQLite DB, factory + herdr logs, agent transcripts,
//                                       event timelines, gh/herdr argv logs, kept world dirs)
//
// Deliberately dependency-free and defensive: a wedged or crashed suite is exactly when the report
// is needed, so every missing or malformed file degrades to a note in the output instead of a throw.
//
// Usage:
//   node test/e2e/harness/report.ts <artifactsDir>      # writes <artifactsDir>/summary.md
//   import { writeSummary } from "./report.ts"
import type { Dirent } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

// --------------------------------------------------------------------------- vitest json shapes
// Mirrors of vitest's JsonTestResults, narrowed to the fields we read and all optional — the file
// is parsed from disk, so it is untrusted input, not a typed value.

interface JsonAssertion {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status?: string;
  duration?: number | null;
  failureMessages?: string[] | null;
}

interface JsonFileResult {
  name?: string;
  status?: string;
  message?: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: JsonAssertion[];
}

interface JsonResults {
  success?: boolean;
  startTime?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: JsonFileResult[];
}

// --------------------------------------------------------------------------- report model

export interface ScenarioRow {
  /** Scenario name — the leaf test title, matched against the scenarios/<name>/ artifact dir. */
  name: string;
  /** Full vitest test name (suite path + title), kept because -t filters match against it. */
  fullName: string;
  lane: string;
  tier: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  durationMs: number | null;
  /** First line of the first failure message — the assertion that actually failed. */
  failure: string | null;
  /** Full failure text, emitted verbatim under a details block. */
  failureDetail: string | null;
  /** Artifact paths, relative to the artifacts dir. */
  artifacts: string[];
  /** The scenario's own `metrics.json`, when it recorded one (World.recordMetrics). */
  metrics: Record<string, string | number> | null;
}

export interface ReportModel {
  artifactsDir: string;
  generatedAt: string;
  scenarios: ScenarioRow[];
  /** Run-wide files at the top of the artifacts dir (results.json, junit.xml, suite.log, …). */
  runArtifacts: string[];
  totals: { total: number; passed: number; failed: number; skipped: number; durationMs: number };
  success: boolean;
  notes: string[];
  env: {
    lane: string;
    tier: string;
    keep: string;
    image: string;
    imageId: string;
    nodeVersion: string;
    herdrVersion: string;
  };
}

const UNSET = "unknown";

function env(name: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : UNSET;
}

// A scenario declares its lane/tier in the spec, and the harness is expected to encode them in the
// test name as `[lane:tier]` or `(lane, tier)`. When it does not, fall back to the run-wide flags —
// which is right for every scenario that did not override them.
function laneTierFrom(fullName: string, fallbackLane: string, fallbackTier: string): { lane: string; tier: string } {
  const lane = /\b(real|fake)\b/i.exec(fullName)?.[1]?.toLowerCase();
  const tier = /\b(scripted|ds4)\b/i.exec(fullName)?.[1]?.toLowerCase();
  return { lane: lane ?? fallbackLane, tier: tier ?? fallbackTier };
}

function normaliseStatus(raw: string | undefined): ScenarioRow["status"] {
  switch (raw) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
    case "pending":
    case "todo":
    case "disabled":
      return "skipped";
    default:
      return "unknown";
  }
}

// vitest failure messages start with the assertion line and then a stack. The table wants the
// former; the details block gets the whole thing.
function firstLine(message: string): string {
  for (const line of message.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("at ")) return t;
  }
  return message.trim().split("\n")[0] ?? "";
}

async function readJson(path: string): Promise<{ value: unknown; note: string | null }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { value: null, note: `missing ${basename(path)} — the suite did not get far enough to write it` };
  }
  try {
    return { value: JSON.parse(raw) as unknown, note: null };
  } catch (err) {
    return { value: null, note: `${basename(path)} is not valid JSON (${String(err)})` };
  }
}

/** Every file under `dir`, as paths relative to `base`, sorted, depth-limited and count-capped. */
/** A scenario's recorded numbers. Malformed or absent ⇒ null: a summary must never fail to render
 *  because a measurement file is unreadable. */
async function readMetrics(path: string): Promise<Record<string, string | number> | null> {
  const { value } = await readJson(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

async function listFiles(dir: string, base: string, depth = 4, cap = 60): Promise<string[]> {
  if (depth < 0) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await listFiles(full, base, depth - 1, cap);
      // A kept world dir is thousands of files; name it and move on.
      if (nested.length > cap) {
        out.push(`${relative(base, full)}/ (${nested.length}+ files)`);
      } else {
        out.push(...nested);
      }
    } else {
      let size = "";
      try {
        size = ` (${humanBytes((await stat(full)).size)})`;
      } catch {
        size = "";
      }
      out.push(`${relative(base, full)}${size}`);
    }
    if (out.length > cap) {
      out.push("…");
      break;
    }
  }
  return out;
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_MARK: Record<ScenarioRow["status"], string> = {
  passed: "pass",
  failed: "FAIL",
  skipped: "skip",
  unknown: "?",
};

// A markdown table cell cannot contain a raw pipe or newline.
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

// Artifact dirs are keyed by scenario name, but a vitest title may carry decoration
// ("w2pr-happy [real:scripted]"). Exact match wins; otherwise the LONGEST containing key, so a dir
// named `pr` never steals the artifacts of `pr-closed-park`.
function matchScenarioDir(name: string, dirs: Map<string, string>): string | null {
  if (dirs.has(name)) return name;
  let best: string | null = null;
  for (const k of dirs.keys()) {
    if (name.includes(k) && (best === null || k.length > best.length)) best = k;
  }
  return best;
}

function longestBacktickRun(s: string): number {
  let best = 0;
  for (const run of s.match(/`+/g) ?? []) best = Math.max(best, run.length);
  return best;
}

// --------------------------------------------------------------------------- collection

export async function collect(artifactsDir: string): Promise<ReportModel> {
  const dir = resolve(artifactsDir);
  const notes: string[] = [];
  const fallbackLane = env("HF_E2E_LANE");
  const fallbackTier = env("HF_E2E_TIER");

  const { value, note } = await readJson(join(dir, "results.json"));
  if (note) notes.push(note);
  const results = (value ?? {}) as JsonResults;

  // scenarios/<name>/ dirs, so a scenario that produced artifacts but never reported (crashed the
  // worker, timed out the file) still shows up in the report.
  const scenarioDirs = new Map<string, string>();
  const scenariosRoot = join(dir, "scenarios");
  try {
    for (const e of await readdir(scenariosRoot, { withFileTypes: true })) {
      if (e.isDirectory()) scenarioDirs.set(e.name, join(scenariosRoot, e.name));
    }
  } catch {
    notes.push("no scenarios/ directory — per-scenario artifacts were not collected");
  }

  const rows: ScenarioRow[] = [];
  const seenDirs = new Set<string>();

  for (const file of results.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const title = (a.title ?? "").trim();
      const full = (a.fullName ?? [...(a.ancestorTitles ?? []), title].join(" > ")).trim();
      const name = title || full || "<unnamed>";
      const { lane, tier } = laneTierFrom(full || name, fallbackLane, fallbackTier);
      const messages = (a.failureMessages ?? []).filter((m): m is string => typeof m === "string" && m.length > 0);
      const detail = messages.length ? messages.join("\n\n") : null;

      const dirKey = matchScenarioDir(name, scenarioDirs);
      if (dirKey) seenDirs.add(dirKey);

      rows.push({
        name,
        fullName: full || name,
        lane,
        tier,
        status: normaliseStatus(a.status),
        durationMs: typeof a.duration === "number" ? a.duration : null,
        failure: detail ? firstLine(detail) : null,
        failureDetail: detail,
        artifacts: dirKey ? await listFiles(scenarioDirs.get(dirKey)!, dir) : [],
        metrics: dirKey ? await readMetrics(join(scenarioDirs.get(dirKey)!, "metrics.json")) : null,
      });
    }

    // A file that failed to load (import error, harness crash) reports no assertions at all.
    if (file.status === "failed" && !(file.assertionResults ?? []).some((a) => a.status === "failed")) {
      const msg = (file.message ?? "").trim();
      if (msg) {
        rows.push({
          name: basename(file.name ?? "<unknown file>"),
          fullName: file.name ?? "<unknown file>",
          lane: fallbackLane,
          tier: fallbackTier,
          status: "failed",
          durationMs:
            typeof file.endTime === "number" && typeof file.startTime === "number"
              ? file.endTime - file.startTime
              : null,
          failure: firstLine(msg),
          failureDetail: msg,
          artifacts: [],
          metrics: null,
        });
      }
    }
  }

  // Artifact dirs with no matching result: the scenario ran and then the worker died.
  for (const [name, path] of scenarioDirs) {
    if (seenDirs.has(name)) continue;
    rows.push({
      name,
      fullName: name,
      lane: fallbackLane,
      tier: fallbackTier,
      status: "unknown",
      durationMs: null,
      failure: "no result recorded in results.json (worker crashed or the run was interrupted?)",
      failureDetail: null,
      artifacts: await listFiles(path, dir),
      metrics: await readMetrics(join(path, "metrics.json")),
    });
  }

  rows.sort((a, b) => {
    const rank = (s: ScenarioRow["status"]) => (s === "failed" ? 0 : s === "unknown" ? 1 : s === "skipped" ? 3 : 2);
    return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
  });

  const totals = {
    total: rows.length,
    passed: rows.filter((r) => r.status === "passed").length,
    failed: rows.filter((r) => r.status === "failed").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    durationMs: rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
  };
  const unresolved = rows.filter((r) => r.status === "unknown").length;
  if (unresolved) notes.push(`${unresolved} scenario(s) have artifacts but no recorded result`);

  // Top-level files only — summary.md is excluded because we are about to (re)write it.
  const runArtifacts = (await listFiles(dir, dir, 0)).filter((p) => !p.startsWith("summary.md"));

  return {
    artifactsDir: dir,
    generatedAt: new Date().toISOString(),
    scenarios: rows,
    runArtifacts,
    totals,
    // Trust the reporter's own verdict when it is present; otherwise derive it, and never call an
    // empty run green.
    success: typeof results.success === "boolean" ? results.success && !unresolved : totals.total > 0 && totals.failed === 0 && !unresolved,
    notes,
    env: {
      lane: fallbackLane,
      tier: fallbackTier,
      keep: env("HF_E2E_KEEP"),
      image: env("HF_E2E_IMAGE"),
      imageId: env("HF_E2E_IMAGE_ID"),
      nodeVersion: env("HF_E2E_NODE_VERSION"),
      herdrVersion: env("HF_E2E_HERDR_VERSION"),
    },
  };
}

// --------------------------------------------------------------------------- rendering

export function render(model: ReportModel): string {
  const L: string[] = [];
  const { totals, env: e } = model;

  L.push("# herdr-factory e2e run");
  L.push("");
  L.push(
    `**${model.success ? "PASS" : "FAIL"}** — ${totals.passed}/${totals.total} passed` +
      (totals.failed ? `, ${totals.failed} failed` : "") +
      (totals.skipped ? `, ${totals.skipped} skipped` : "") +
      ` in ${fmtDuration(totals.durationMs)}`,
  );
  L.push("");
  L.push(`Generated ${model.generatedAt} from \`${model.artifactsDir}\`.`);
  L.push("");

  if (model.notes.length) {
    L.push("> [!NOTE]");
    for (const n of model.notes) L.push(`> ${n}`);
    L.push("");
  }

  L.push("## Scenarios");
  L.push("");
  if (!model.scenarios.length) {
    L.push("_No scenarios reported._");
    L.push("");
  } else {
    L.push("| Scenario | Lane | Tier | Status | Duration | Failure |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const s of model.scenarios) {
      L.push(
        `| \`${cell(s.name)}\` | ${cell(s.lane)} | ${cell(s.tier)} | ${STATUS_MARK[s.status]} | ` +
          `${fmtDuration(s.durationMs)} | ${s.failure ? cell(s.failure) : "—"} |`,
      );
    }
    L.push("");
  }

  // Measured numbers, not just pass/fail: a performance scenario that still passes while its p95
  // doubles is exactly the thing a summary should show without being asked.
  const measured = model.scenarios.filter((s) => s.metrics);
  if (measured.length) {
    L.push("## Measurements");
    L.push("");
    for (const s of measured) {
      L.push(`**\`${cell(s.name)}\`** — ${Object.entries(s.metrics!).map(([k, v]) => `${k}: \`${cell(String(v))}\``).join(", ")}`);
      L.push("");
    }
  }

  const failed = model.scenarios.filter((s) => s.status === "failed" && s.failureDetail);
  if (failed.length) {
    L.push("## Failures");
    L.push("");
    for (const s of failed) {
      const body = s.failureDetail ?? "";
      // An assertion diff can itself contain a triple-backtick fence; outrun it.
      const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
      L.push(`### ${s.name}`);
      L.push("");
      L.push(`\`${s.fullName}\``);
      L.push("");
      L.push(fence);
      L.push(body);
      L.push(fence);
      L.push("");
    }
  }

  L.push("## Artifacts");
  L.push("");
  const withArtifacts = model.scenarios.filter((s) => s.artifacts.length);
  if (!withArtifacts.length) {
    L.push("_No per-scenario artifacts were collected._");
    L.push("");
  } else {
    for (const s of withArtifacts) {
      L.push(`### ${s.name}`);
      L.push("");
      for (const p of s.artifacts) L.push(`- \`${p}\``);
      L.push("");
    }
  }
  if (model.runArtifacts.length) {
    L.push("### run-level");
    L.push("");
    for (const p of model.runArtifacts) L.push(`- \`${p}\``);
    L.push("");
  }

  L.push("## Run");
  L.push("");
  L.push("| | |");
  L.push("| --- | --- |");
  L.push(`| lane | ${cell(e.lane)} |`);
  L.push(`| tier | ${cell(e.tier)} |`);
  L.push(`| keep worlds | ${cell(e.keep)} |`);
  L.push(`| image | ${cell(e.image)} |`);
  L.push(`| image id | ${cell(e.imageId)} |`);
  L.push(`| node | ${cell(e.nodeVersion)} |`);
  L.push(`| herdr | ${cell(e.herdrVersion)} |`);
  L.push(`| total | ${totals.total} |`);
  L.push(`| passed | ${totals.passed} |`);
  L.push(`| failed | ${totals.failed} |`);
  L.push(`| skipped | ${totals.skipped} |`);
  L.push(`| wall (sum of tests) | ${fmtDuration(totals.durationMs)} |`);
  L.push("");

  return L.join("\n");
}

/** Collect + render + write `<artifactsDir>/summary.md`. Returns the path written. */
export async function writeSummary(artifactsDir: string): Promise<string> {
  const model = await collect(artifactsDir);
  const out = join(resolve(artifactsDir), "summary.md");
  await writeFile(out, render(model), "utf8");
  return out;
}

// --------------------------------------------------------------------------- cli

// `node test/e2e/harness/report.ts <artifactsDir>`. Only when run directly, so importing the module
// is free of side effects.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const target = process.argv[2] ?? process.env.HF_E2E_ARTIFACTS ?? "artifacts/e2e/local";
  writeSummary(target)
    .then((path) => {
      process.stdout.write(`${path}\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`report: failed to write summary for ${target}: ${String(err)}\n`);
      process.exitCode = 1;
    });
}
