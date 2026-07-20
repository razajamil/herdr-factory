// `herdr-factory init` — scaffold a repo config FROM INSIDE the repo. You run it from within your
// target project checkout; it writes a ready-to-edit `~/.config/herdr-factory/repos/<name>/config.yml`
// (plus a secrets `env` scaffold for sources that need credentials), inferring what it can from the
// checkout: the repo path (the git top-level), the config folder name (the repo dir basename), and —
// for a github_issues scaffold — the `owner/name` from the git origin. Everything else is a commented
// placeholder the annotated schema modeline validates as you edit.
//
// This module is the engine of the command; the CLI wrapper (src/cli/index.ts) only parses flags and
// prints the result. It's split into a PURE renderer (renderConfigYaml — no IO, so the scaffold's
// validity is unit-testable) and the IO orchestrator (initRepo).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertMainCheckout, RepoConfigSchema, repoConfigDir, writeConfigSchema } from "./config.ts";
import { parseGhRepo } from "./clients/git.ts";
import { run } from "./clients/exec.ts";
import { expandHome } from "./paths.ts";
import { descriptorFor } from "./sources/registry.ts";
import type { SourceType } from "./types.ts";

export interface InitOptions {
  /** The config folder name (what you pass to `--repo`). Default: the repo directory's basename. */
  repoName?: string;
  /** The work source to scaffold. Default: `github_issues` when the origin resolves to owner/name
   *  (zero-config — auth is your `gh` login and the repo derives from origin), else `local_markdown`. */
  source?: SourceType;
  /** The repo checkout to point at. Default: the git top-level of `cwd`. */
  path?: string;
  /** Overwrite an existing config.yml (otherwise init refuses, to protect a hand-edited config). */
  force?: boolean;
  /** Where init runs from — the checkout it infers the path/origin from. Default: process.cwd(). */
  cwd?: string;
}

export interface InitResult {
  repoName: string;
  repoPath: string;
  configPath: string;
  schemaPath: string;
  source: SourceType;
  ghRepo: string | null;
  /** The env file written for a source that needs credentials (with empty, fill-me keys), else undefined. */
  envPath?: string;
  /** The required secret env keys the operator must fill in (empty when the source needs none). */
  secretKeys: string[];
  /** Human-facing follow-up steps to print after scaffolding. */
  nextSteps: string[];
}

/** Shorten a leading home-dir prefix to `~` for a readable, portable config value (expandHome
 *  reverses it at load). Absolute paths outside home are left as-is. */
function homeShorten(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return `~${p.slice(home.length)}`;
  return p;
}

/** Resolve the target checkout: an explicit `--path`, else the git top-level of `cwd`. Throws a
 *  clear error when neither yields a git checkout (init is meant to run FROM INSIDE a repo). */
async function resolveRepoPath(opts: InitOptions): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.path) {
    const abs = isAbsolute(opts.path) ? opts.path : resolve(cwd, expandHome(opts.path));
    return abs;
  }
  const r = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  const top = r.stdout.trim();
  if (r.code !== 0 || !top) {
    throw new Error(`not inside a git repository (${cwd}) — run \`init\` from within your project checkout, or pass --path <checkout>`);
  }
  return top;
}

/** owner/name from the checkout's git origin, or null (no origin / unparseable). */
async function resolveGhRepo(repoPath: string): Promise<string | null> {
  const r = await run("git", ["-C", repoPath, "remote", "get-url", "origin"], { cwd: repoPath, allowFail: true });
  if (r.code !== 0) return null;
  return parseGhRepo(r.stdout.trim());
}

/** The four fields that vary per source type: the `work_sources` block, the belt name/label, and
 *  any follow-up notes. Kept in one place so a new source's scaffold is a single entry. */
interface SourceScaffold {
  /** The `work_sources` list body (already list-item indented, trailing newline). */
  sourceBlock: string;
  /** The belt's `source:` reference (the resolved source name). */
  sourceRef: string;
  /** The belt name. */
  beltName: string;
  /** The per-belt pickup label (label-driven sources only); undefined ⇒ no `label:` line. */
  label?: string;
  /** Extra follow-up guidance beyond the generic "edit the placeholders" note. */
  notes: string[];
}

function sourceScaffold(source: SourceType, repoName: string, ghRepo: string | null): SourceScaffold {
  switch (source) {
    case "jira":
      return {
        sourceBlock:
          `  - type: jira\n` +
          `    name: jira\n` +
          `    jira:\n` +
          `      base_url: https://your-org.atlassian.net # EDIT: your Atlassian site\n` +
          `      project: PROJ # EDIT: your project key\n` +
          `      board: "123" # EDIT: the Agile board id pickup pulls from (required)\n` +
          `      # status: defaults — todo: To Do · in_development: In Progress · review: In Review.\n` +
          `      #   Add \`done: <status>\` to move the ticket there when the PR merges (opt-in).\n`,
        sourceRef: "jira",
        beltName: "tickets-to-prs",
        label: "agent",
        notes: ["Fill in jira.base_url / project / board, then add JIRA_EMAIL + JIRA_API_TOKEN to the env file."],
      };
    case "github_issues": {
      // repo defaults to the origin (ghRepo). When the origin didn't resolve, pin a placeholder so
      // the source is buildable — a github_issues source with no resolvable repo throws at startup.
      const repoLine = ghRepo ? `    github_issues: {} # repo defaults to this checkout's origin (${ghRepo})\n` : `    github_issues:\n      repo: owner/name # EDIT: no git origin resolved — set the GitHub repo to poll\n`;
      return {
        sourceBlock: `  - type: github_issues\n    name: issues\n${repoLine}`,
        sourceRef: "issues",
        beltName: "issues-to-prs",
        label: "agent",
        notes: ghRepo
          ? ["Auth is your `gh` CLI login — no credentials to add. Label an issue `agent` and move on."]
          : ["Set github_issues.repo to the owner/name you want to poll (no git origin was found)."],
      };
    }
    case "local_markdown":
      return {
        sourceBlock:
          `  - type: local_markdown\n` +
          `    name: briefs\n` +
          `    local_markdown:\n` +
          `      folder: ~/dev/${repoName}-work-items # EDIT: a folder of *.md briefs — each file is one work item\n`,
        sourceRef: "briefs",
        beltName: "briefs-to-prs",
        notes: [`Create the briefs folder (default \`~/dev/${repoName}-work-items\`) and drop a *.md brief in it — no credentials needed.`],
      };
    case "sentry":
      return {
        sourceBlock:
          `  - type: sentry\n` +
          `    name: sentry\n` +
          `    sentry:\n` +
          `      organization: your-org # EDIT: the Sentry org slug\n` +
          `      projects: [] # optional: limit to specific project slugs (omit all = every project)\n` +
          `      query: "is:unresolved level:error"\n`,
        sourceRef: "sentry",
        beltName: "errors-to-prs",
        notes: ["Fill in sentry.organization, then add SENTRY_AUTH_TOKEN to the env file."],
      };
  }
}

/** Render the full config.yml text for a scaffold — PURE (no IO), so its validity is unit-testable.
 *  Heavily commented and carrying the schema modeline, matching the hand-written example config. */
export function renderConfigYaml(params: { repoPath: string; repoName: string; source: SourceType; ghRepo: string | null }): string {
  const { sourceBlock, sourceRef, beltName, label, notes } = sourceScaffold(params.source, params.repoName, params.ghRepo);
  const githubLine = params.ghRepo ? `  # github: ${params.ghRepo} # default: derived from the origin remote\n` : "";
  const labelLine = label ? `    label: ${label} # items carrying this label are eligible for this belt (required — no default)\n` : "";
  return (
    `# yaml-language-server: $schema=../../config.schema.json\n` +
    `# herdr-factory config for "${params.repoName}" — scaffolded by \`herdr-factory init\`.\n` +
    `# Edit the EDIT-marked placeholders below; anything omitted falls back to the engine defaults.\n` +
    `# ${notes.join(" ")}\n` +
    `\n` +
    `repo:\n` +
    `  path: ${homeShorten(params.repoPath)} # the MAIN (non-linked) checkout; worktrees fork from base_ref\n` +
    `  base_ref: origin/main # branch worktrees fork from\n` +
    githubLine +
    `\n` +
    `# ── Work sources: WHERE work is pulled from (backends only — no pipeline here). ──\n` +
    `work_sources:\n` +
    sourceBlock +
    `\n` +
    `# ── Belts: WHAT we do with the work. A belt pairs a source with an ordered pipeline. ──\n` +
    `belt:\n` +
    `  - name: ${beltName}\n` +
    `    source: ${sourceRef}\n` +
    labelLine +
    `    steps: # the canonical work → review → pr pipeline (add an { type: evidence } step to verify visually)\n` +
    `      - { type: work } # no tab/pane → the factory spawns each step's pane\n` +
    `      - { type: review }\n` +
    `      - { type: pr }\n`
  );
}

/** Write a fill-me secrets `env` scaffold (chmod 600) for a source's REQUIRED secrets: each key is
 *  written empty, above a comment with its hint, so `doctor` flags it as missing (actionable) until
 *  filled. Never clobbers an existing env file. Returns the keys written, or [] when none/skipped. */
function scaffoldEnvFile(source: SourceType, repoDir: string): { path?: string; keys: string[] } {
  const required = descriptorFor(source).secrets.filter((s) => s.required);
  if (required.length === 0) return { keys: [] };
  const path = join(repoDir, "env");
  if (existsSync(path)) return { path, keys: required.map((s) => s.envKey) }; // keep the operator's real creds
  const body =
    `# herdr-factory secrets — fill these in (this file is chmod 600).\n` +
    required.map((s) => `# ${s.envKey}: ${s.hint}\n${s.envKey}=`).join("\n") +
    `\n`;
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600); // ensure 600 even if a prior umask widened it
  return { path, keys: required.map((s) => s.envKey) };
}

/** Scaffold a repo config from inside a checkout: resolve the path/name/source, render + validate
 *  the config.yml, write it (plus a secrets env scaffold when the source needs one) and the editor
 *  JSON Schema. Idempotency: refuses to overwrite an existing config.yml unless `force`. */
export async function initRepo(opts: InitOptions = {}): Promise<InitResult> {
  const repoPath = await resolveRepoPath(opts);
  // init targets the MAIN checkout, matching the invariant loadConfig enforces (herdr can't fork a
  // worktree from a linked worktree) — fail here with a clear message rather than at first tick.
  assertMainCheckout(repoPath);
  const ghRepo = await resolveGhRepo(repoPath);
  const source: SourceType = opts.source ?? (ghRepo ? "github_issues" : "local_markdown");
  const repoName = opts.repoName ?? basename(repoPath);

  const repoDir = repoConfigDir(repoName);
  const configPath = join(repoDir, "config.yml");
  if (existsSync(configPath) && !opts.force) {
    throw new Error(`config already exists at ${configPath} — pass --force to overwrite it (or edit it directly)`);
  }

  const yaml = renderConfigYaml({ repoPath, repoName, source, ghRepo });
  // Guard: the scaffold must always be a structurally-valid config. Cross-field rules that need a
  // real checkout (assertMainCheckout) aren't run here, but the schema + superRefine are.
  const parsed = RepoConfigSchema.safeParse(parseYaml(yaml));
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`internal error: scaffolded config did not validate:\n${detail}`);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, yaml);
  const schemaPath = writeConfigSchema(); // so the modeline's $schema resolves for editor autocomplete
  const env = scaffoldEnvFile(source, repoDir);

  const nextSteps: string[] = [`Edit ${configPath} (the EDIT-marked placeholders).`];
  for (const note of sourceScaffold(source, repoName, ghRepo).notes) nextSteps.push(note);
  if (env.path) nextSteps.push(`Add your credentials to ${env.path} — ${env.keys.join(" + ")}.`);
  nextSteps.push(`Verify it: herdr-factory --repo ${repoName} doctor --deep`);

  return { repoName, repoPath, configPath, schemaPath, source, ghRepo, envPath: env.path, secretKeys: env.keys, nextSteps };
}
