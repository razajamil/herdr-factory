import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SourceType } from "./types.ts";

// ── Work sources: where to poll work from (no agents/pipeline here anymore — that's a belt). ──

// The Jira source's where-to-poll block. base_url is the Atlassian site (not a secret; auth —
// email + token — stays in the shared env).
const JiraBlockSchema = z.object({
  base_url: z.url().transform((s) => s.replace(/\/+$/, "")),
  project: z.string(),
  board: z.coerce.string(),
  label: z.string().default("agent"),
  status: z
    .object({
      todo: z.string().default("To Do"),
      in_development: z.string().default("In Progress"),
      review: z.string().default("In Review"),
    })
    .prefault({}),
});

// The local_markdown source's config: a folder of *.md files, each one work item. Lifecycle is
// tracked internally in the work_items table (herdr-factory owns the status of record here).
const LocalMarkdownBlockSchema = z.object({
  folder: z.string(),
});

// A work source is just identity + a type-specific backend block. The OPTIONAL `name` (default =
// type, unique within the repo) is what a belt's `source:` references and what each run records on
// its `work_source` column.
// `.strict()` on the union members: an unknown key (a typo, or the wrong type's block) is rejected
// at parse time with a clear "Unrecognized key" rather than being silently dropped.
const sourceName = z.string().trim().min(1).optional();
const JiraSourceSchema = z.object({ type: z.literal("jira"), name: sourceName, jira: JiraBlockSchema }).strict();
const LocalMarkdownSourceSchema = z
  .object({ type: z.literal("local_markdown"), name: sourceName, local_markdown: LocalMarkdownBlockSchema })
  .strict();
const WorkSourceSchema = z.discriminatedUnion("type", [JiraSourceSchema, LocalMarkdownSourceSchema]);

// ── Belts: a (source + ordered steps) pairing. The belt is the unit of work flow. ──

// A step's herdr layout target. OPTIONAL, both-or-neither: when tab+pane are set the dispatcher
// waits for the user's layout to bring that pane up (with an idle agent) and delivers the prompt
// there — it never spawns its own. When omitted, it spawns a dedicated pane itself.
const layoutFields = { tab: z.string().optional(), pane: z.string().optional() };
const bothOrNeither = (a: { tab?: string; pane?: string }) => (a.tab == null) === (a.pane == null);
const layoutRefine = {
  message: "tab and pane must be set together (or both omitted to spawn a dedicated pane)",
  path: ["pane"] as string[],
};

// Where a `prompt_file` is resolved from: `config` = relative to this repo's config folder
// (repos/<name>/); `repo` = relative to the target repo checkout, read from the run's WORKTREE at
// render time (so the prompt can live version-controlled in the codebase).
const PromptSourceSchema = z.enum(["repo", "config"]);
const promptFileFields = { prompt_file: z.string().optional(), prompt_file_source: PromptSourceSchema.optional() };
const promptSourceRefine = [
  (a: { prompt_file?: string; prompt_file_source?: "repo" | "config" }) => !a.prompt_file || a.prompt_file_source != null,
  { message: "prompt_file_source is required when prompt_file is set", path: ["prompt_file_source"] as string[] },
] as const;

// work_to_pull_request belts have exactly three engine-defined steps (fix → review → pr) whose
// prompts the engine ships; an agent block picks the layout pane and may OPTIONALLY add a
// `prompt_file` (with a required `prompt_file_source`) that AUGMENTS the engine prompt for that
// step. All three required.
const PrAgentSchema = z
  .object({ ...layoutFields, ...promptFileFields })
  .strict()
  .refine(bothOrNeither, layoutRefine)
  .refine(...promptSourceRefine);
const PrAgentsSchema = z.object({ fix: PrAgentSchema, review: PrAgentSchema, pr: PrAgentSchema }).strict();

// Step names are used in file paths (prompt-<name>.md / handoff-<name>.md), pane labels, and the
// step-done CLI arg — so keep them to a git/path-safe lowercase slug.
const StepNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "step name must be a lowercase slug ([a-z0-9_-], starting alphanumeric)");

// A custom belt's user-defined step. `prompt_file` (required) is the WHOLE step body — the engine
// adds only the handover scaffold — and `prompt_file_source` (required) says where to read it from.
// Optional per-step budget + commit-stall heartbeat (off by default: research/proposal-style steps
// legitimately make no commits).
const CustomStepSchema = z
  .object({
    name: StepNameSchema,
    prompt_file: z.string(),
    prompt_file_source: PromptSourceSchema,
    budget_seconds: z.coerce.number().int().positive().optional(),
    heartbeat: z.boolean().default(false),
    ...layoutFields,
  })
  .strict()
  .refine(bothOrNeither, layoutRefine);

// A per-belt branch-name template (the worktree + workspace derive from it). Must include
// {{work_id}} so the branch is identifiable by ticket; a short unique suffix is appended
// automatically (see branchName) so each claim — including a RE-claim of a previously-merged
// ticket — gets a distinct branch. Vars: {{work_id}} {{work_slug}} (<=20) {{work_full_slug}}
// (<=50) {{work_type}} {{semantic_work_prefix}} (fix|chore|feature).
const WorkspaceNameSchema = z
  .string()
  .refine((s) => /\{\{\s*work_id\s*\}\}/.test(s), {
    message: "workspace_name must include {{work_id}} so each item gets a unique branch",
  })
  .optional();

// Fields every belt shares. `source` references a work_source by name (validated below). `match`
// is an OPTIONAL path to a `.ts` module (default export = predicate); when omitted the belt
// accepts anything from its source. Lower `priority` = matched first (first matching belt claims).
const beltBase = {
  name: z.string().trim().min(1),
  source: z.string().trim().min(1),
  priority: z.coerce.number().int().default(100),
  workspace_name: WorkspaceNameSchema,
  match: z.string().optional(),
};

// `.strict()` so a w2pr belt can't carry `steps`, a custom belt can't carry `agents`, and typos in
// any belt field are rejected at parse time (the discriminated union routes on belt_type; strict
// enforces that only that variant's fields are present).
const WorkToPrBeltSchema = z
  .object({ belt_type: z.literal("work_to_pull_request"), ...beltBase, agents: PrAgentsSchema })
  .strict();
const CustomBeltSchema = z
  .object({
    belt_type: z.literal("custom"),
    ...beltBase,
    steps: z.array(CustomStepSchema).min(1, "a custom belt needs at least one step"),
  })
  .strict();
const BeltSchema = z.discriminatedUnion("belt_type", [WorkToPrBeltSchema, CustomBeltSchema]);

export const RepoConfigSchema = z
  .object({
    repo: z.object({
      path: z.string(),
      base_ref: z.string().default("origin/main"),
      github: z.string().optional(),
    }),
    limits: z
      .object({
        max_active: z.coerce.number().int().positive().default(3),
        watch_hours: z.coerce.number().positive().default(7),
        develop_budget_seconds: z.coerce.number().int().positive().default(5400),
        stall_seconds: z.coerce.number().int().positive().default(2700),
        review_budget_seconds: z.coerce.number().int().positive().default(1800),
        pr_budget_seconds: z.coerce.number().int().positive().default(3600),
        // Default budget for a custom belt's step when it sets no `budget_seconds` of its own.
        step_budget_seconds: z.coerce.number().int().positive().default(3600),
        tick_interval_seconds: z.coerce.number().int().positive().default(60),
        // How long to wait for a step's configured tab/pane to come up (with an idle agent)
        // before flagging the item for attention. Generous by default to allow the user's
        // layout setup + dev-server startup to finish; only applies to steps with a tab/pane.
        layout_wait_seconds: z.coerce.number().int().positive().default(600),
      })
      .prefault({}),
    // Backends this repo can pull work from (≥1). Each just names a type + its backend block;
    // the pipeline/agents live on a belt now.
    work_sources: z.array(WorkSourceSchema).min(1, "work_sources must list at least one source"),
    // Belts (≥1): each pairs a source with an ordered pipeline. At claim time belts are walked in
    // priority order and the first whose `match` accepts an item claims it (first match wins).
    belt: z.array(BeltSchema).min(1, "belt must list at least one belt"),
  })
  .superRefine((cfg, ctx) => {
    // Work source names unique on the RESOLVED name (name ?? type), so two unnamed jira sources
    // correctly collide on "jira" rather than both passing as undefined.
    const sourceNames = new Set<string>();
    cfg.work_sources.forEach((s, i) => {
      const name = s.name ?? s.type;
      if (sourceNames.has(name)) {
        ctx.addIssue({ code: "custom", message: `duplicate work source name "${name}" — give each source a unique name`, path: ["work_sources", i, "name"] });
      }
      sourceNames.add(name);
    });
    // Belt names unique; each belt.source references a configured work source; custom step names
    // unique within their belt.
    const beltNames = new Set<string>();
    cfg.belt.forEach((b, i) => {
      if (beltNames.has(b.name)) {
        ctx.addIssue({ code: "custom", message: `duplicate belt name "${b.name}" — give each belt a unique name`, path: ["belt", i, "name"] });
      }
      beltNames.add(b.name);
      if (!sourceNames.has(b.source)) {
        ctx.addIssue({ code: "custom", message: `belt "${b.name}" references unknown work source "${b.source}" (configured: ${[...sourceNames].join(", ") || "none"})`, path: ["belt", i, "source"] });
      }
      if (b.belt_type === "custom") {
        const stepNames = new Set<string>();
        b.steps.forEach((s, j) => {
          if (stepNames.has(s.name)) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" has duplicate step name "${s.name}"`, path: ["belt", i, "steps", j, "name"] });
          }
          stepNames.add(s.name);
        });
      }
    });
  });

export interface Secrets {
  jiraEmail: string;
  jiraApiToken: string;
}

export type BeltType = "work_to_pull_request" | "custom";

/** Resolved Jira-source config (present iff type === "jira"). */
export interface JiraSourceCfg {
  baseUrl: string;
  project: string;
  board: string;
  label: string;
  statusTodo: string;
  statusInDev: string;
  statusReview: string;
}

/** Resolved local_markdown-source config (present iff type === "local_markdown"). */
export interface LocalMarkdownSourceCfg {
  folder: string; // ~ / $HOME expanded
}

/** One configured work source: identity + the type-specific backend block. No pipeline here. */
export interface WorkSourceConfig {
  name: string;
  type: SourceType;
  jira?: JiraSourceCfg;
  localMarkdown?: LocalMarkdownSourceCfg;
}

/** One resolved belt step. The body the agent gets is assembled at RENDER time (step.ts): the
 *  `enginePrompt` base (work_to_pull_request steps only — undefined for custom) PLUS, if
 *  `promptFile` is set, the user prompt read from `promptFileSource` (`config` ⇒ the repo's config
 *  folder; `repo` ⇒ the run's worktree) — augmenting the engine base for w2pr, or being the whole
 *  body for custom. The engine then adds the handover scaffold + @@TOKEN@@ substitution. `opensPr`
 *  is true only for the work_to_pull_request `pr` step (the one that watches GitHub for a PR). */
export interface StepConfig {
  name: string;
  tab?: string;
  pane?: string;
  enginePrompt?: string; // shipped base body (w2pr); undefined for custom
  promptFile?: string; // user prompt path as written in config (optional for w2pr, required for custom)
  promptFileSource?: "config" | "repo"; // present iff promptFile is
  budgetSeconds: number;
  heartbeat: boolean; // commit-HEAD stall heartbeat applies to this step
  opensPr: boolean;
}

/** One resolved belt: a (source + ordered steps) pairing with its lifecycle. `watchPr` true means
 *  the engine runs the token-free PR-watch (reviewing phase) after the last step. `matchFile` is
 *  the resolved path to the belt's `.ts` predicate (the predicate fn itself is loaded in buildDeps,
 *  which is async); undefined ⇒ the belt accepts anything from its source. */
export interface BeltConfig {
  name: string;
  beltType: BeltType;
  source: string; // work_source name
  priority: number;
  workspaceName?: string;
  matchFile?: string;
  steps: StepConfig[];
  watchPr: boolean;
}

export interface Config {
  repoName: string;
  repo: { path: string; baseRef: string; github?: string };
  limits: {
    maxActive: number;
    watchHours: number;
    developBudgetSeconds: number;
    stallSeconds: number;
    reviewBudgetSeconds: number;
    prBudgetSeconds: number;
    stepBudgetSeconds: number;
    tickIntervalSeconds: number;
    layoutWaitSeconds: number;
  };
  sources: WorkSourceConfig[];
  belts: BeltConfig[]; // sorted by priority asc (ties: config order)
  guidance?: string;
  paths: {
    configDir: string;
    repoDir: string;
    stateRoot: string;
    stateDir: string;
    dbPath: string;
    logsDir: string;
  };
}

export interface Loaded {
  config: Config;
  secrets: Secrets;
}

// `?.trim() ||` (not `??`): treat an empty/whitespace override as unset, so a stray
// `HERDR_FACTORY_STATE_ROOT=` doesn't collapse every state path to a relative "" root (and stays
// consistent with bin/herdr-factory's `${VAR:-default}`, which also falls back on empty).
function configDir(): string {
  return process.env.HERDR_FACTORY_CONFIG_DIR?.trim() || join(homedir(), ".config", "herdr-factory");
}
function stateRoot(): string {
  return process.env.HERDR_FACTORY_STATE_ROOT?.trim() || join(homedir(), ".local", "state", "herdr-factory");
}

/** Expand a leading `~`/`~/` and any `$HOME`/`${HOME}` to the home directory. Absolute paths and
 *  paths without those tokens are returned unchanged, so it's a safe no-op for already-absolute
 *  config values. Applied uniformly to repo.path and local_markdown.folder. */
export function expandHome(p: string): string {
  let out = p;
  if (out === "~" || out.startsWith("~/")) out = join(homedir(), out.slice(1));
  out = out.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, homedir());
  return out;
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** herdr can't create worktrees from a linked worktree — require the MAIN checkout. */
export function assertMainCheckout(repoPath: string): void {
  const gitPath = join(repoPath, ".git");
  if (!existsSync(gitPath)) {
    throw new Error(`repo.path "${repoPath}" is not a git checkout (no .git)`);
  }
  if (!statSync(gitPath).isDirectory()) {
    throw new Error(
      `repo.path "${repoPath}" looks like a linked worktree (.git is a file); herdr needs the MAIN checkout`,
    );
  }
}

/** Path to the one global DB (repo-agnostic commands like capture-lock need it). */
export function globalDbPath(): string {
  return join(stateRoot(), "herdr-factory.db");
}

/** Machine-global file recording an absolute path to a verified Node >=24 binary. The CLI
 *  self-bakes `process.execPath` here on every run (it only ever runs under >=24); the
 *  `bin/herdr-factory` launcher falls back to it when the caller's active node is older — so the
 *  CLI always runs on its own Node 24 regardless of the caller's cwd, with no version-manager
 *  dependency at runtime. */
export function nodePathFile(): string {
  return join(stateRoot(), "node-path");
}

/** A repo's config folder (`<configDir>/repos/<name>/`) — where its config.yml + env live.
 *  Exposed for tools (e.g. the TUI config editor) that read/write the raw config.yml directly,
 *  without going through loadConfig's parse+validate (so they can edit an as-yet-invalid file and
 *  preserve YAML comments). */
export function repoConfigDir(name: string): string {
  return join(configDir(), "repos", name);
}

/** Every repo configured under `<configDir>/repos/<name>/config.yml`, sorted. The resident
 *  server discovers all of them on startup; the per-repo launchd model needed none of this. */
export function listConfiguredRepos(): string[] {
  const dir = join(configDir(), "repos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "config.yml")))
    .map((d) => d.name)
    .sort();
}

/** Where the running `serve` process advertises itself: `{pid, port, version, startedAt}`.
 *  Written on listen, removed on graceful shutdown. CLI clients + the supervisor read it to
 *  find (and health-check) the server. */
export function serverInfoPath(): string {
  return join(stateRoot(), "server.json");
}

/** TCP port the server binds on 127.0.0.1 (override with HERDR_FACTORY_PORT). The bind itself
 *  is the single-instance guard — a second `serve` fails with EADDRINUSE and exits. */
export function serverPort(): number {
  const p = Number(process.env.HERDR_FACTORY_PORT);
  return Number.isInteger(p) && p > 0 ? p : 8765;
}

/** Server-wide (not per-repo) log dir — the supervisor's launchd stdout/err land here. */
export function serverLogsDir(): string {
  return join(stateRoot(), "logs");
}

/** Load Jira auth (email + token) for a repo. Secrets are strictly PER-REPO — read only from
 *  `<configDir>/repos/<name>/env`. There is no shared/global secrets file. */
export function loadSecrets(repoDir: string): Secrets {
  const env = parseEnvFile(join(repoDir, "env"));
  return {
    jiraEmail: env.JIRA_EMAIL ?? "",
    jiraApiToken: env.JIRA_API_TOKEN ?? "",
  };
}

/** Write Jira auth to `<repoDir>/env` (chmod 600), merging into any existing keys. Only the fields
 *  provided are updated; others in the file are preserved. Counterpart to loadSecrets, used by the
 *  TUI config editor so credentials don't have to be hand-created. */
export function saveSecrets(repoDir: string, secrets: { jiraEmail?: string; jiraApiToken?: string }): void {
  mkdirSync(repoDir, { recursive: true });
  const path = join(repoDir, "env");
  const env = parseEnvFile(path);
  if (secrets.jiraEmail !== undefined) env.JIRA_EMAIL = secrets.jiraEmail;
  if (secrets.jiraApiToken !== undefined) env.JIRA_API_TOKEN = secrets.jiraApiToken;
  const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // ensure 600 even if the file already existed
}

/** The config.yml JSON Schema — derived from `RepoConfigSchema` (single source of truth) so editors
 *  (e.g. the YAML language server) give autocomplete + inline validation. Generated from the INPUT
 *  side (what the user writes); `.strict()` becomes `additionalProperties: false`, so unknown keys
 *  (the classic `agents`-on-a-`custom`-belt mixup, or a typo) are flagged live. Cross-field rules
 *  JSON Schema can't express — belt.source references, unique names, layout both-or-neither,
 *  workspace_name must contain {{work_id}}, match/prompt_file existence — are still enforced by
 *  loadConfig (with readable errors). */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(RepoConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    ...schema,
    title: "herdr-factory repo config (config.yml)",
    description:
      "Structural schema for a per-repo config.yml. Cross-field rules (belt.source refs, unique names, layout both-or-neither, workspace_name {{work_id}}, file existence) are validated at load time, not here.",
  };
}

/** Where the editor-facing JSON Schema is written. Each config.yml points at it relative to itself
 *  with a first-line modeline: `# yaml-language-server: $schema=../../config.schema.json`
 *  (repos/<name>/config.yml is two levels below this configDir file). */
export function configSchemaPath(): string {
  return join(configDir(), "config.schema.json");
}

/** Generate + write the config JSON Schema to configSchemaPath(); returns the path. */
export function writeConfigSchema(): string {
  const path = configSchemaPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  return path;
}

export function loadConfig(repoName: string): Loaded {
  const cfgDir = configDir();
  const repoDir = join(cfgDir, "repos", repoName);
  const ymlPath = join(repoDir, "config.yml");
  if (!existsSync(ymlPath)) {
    throw new Error(`no config for repo "${repoName}" at ${ymlPath}`);
  }

  // safeParse + format the issues into a readable message — a raw ZodError stringifies to an
  // unreadable JSON dump (and the CLI just prints `e.message`). Path "belt.0.steps" etc.
  const result = RepoConfigSchema.safeParse(parseYaml(readFileSync(ymlPath, "utf8")));
  if (!result.success) {
    const detail = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid config for repo "${repoName}" (${ymlPath}):\n${detail}`);
  }
  const parsed = result.data;
  const repoPath = expandHome(parsed.repo.path);
  assertMainCheckout(repoPath);

  const guidancePath = join(repoDir, "guidelines-prompt.md");
  const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, "utf8") : undefined;

  const sources: WorkSourceConfig[] = parsed.work_sources.map((s) => {
    const base = { name: s.name ?? s.type, type: s.type };
    if (s.type === "jira") {
      return {
        ...base,
        jira: {
          baseUrl: s.jira.base_url,
          project: s.jira.project,
          board: s.jira.board,
          label: s.jira.label,
          statusTodo: s.jira.status.todo,
          statusInDev: s.jira.status.in_development,
          statusReview: s.jira.status.review,
        },
      };
    }
    return { ...base, localMarkdown: { folder: expandHome(s.local_markdown.folder) } };
  });
  const sourceTypeByName = new Map(sources.map((s) => [s.name, s.type]));

  // The engine's built-in prompt for a (sourceType, step): prompts/<type>/<step>.md if present,
  // else the shared prompts/<step>.md. Used for work_to_pull_request steps (the engine owns those).
  const shippedPrompt = (sourceType: SourceType, step: string): string => {
    const typed = fileURLToPath(new URL(`prompts/${sourceType}/${step}.md`, import.meta.url));
    const shared = fileURLToPath(new URL(`prompts/${step}.md`, import.meta.url));
    return readFileSync(existsSync(typed) ? typed : shared, "utf8");
  };
  // Resolve a belt-relative file (prompt_file / match) to an absolute path, asserting it exists.
  const resolveFile = (belt: string, what: string, p: string): string => {
    const abs = isAbsolute(p) ? p : join(repoDir, p);
    if (!existsSync(abs)) throw new Error(`belt "${belt}": ${what} not found: ${abs}`);
    return abs;
  };
  // Existence check for a `config`-sourced prompt_file (resolved against the config folder). A
  // `repo`-sourced prompt is read from the run's worktree at render time, so it can't be checked
  // here — a missing one surfaces (with a clear error) when the step is dispatched.
  const checkConfigPromptFile = (belt: string, label: string, source: "config" | "repo", promptFile: string): void => {
    if (source === "config") resolveFile(belt, label, promptFile);
  };

  // The three engine steps of a work_to_pull_request belt (order = pipeline order).
  const PR_STEPS = [
    { name: "fix", budget: parsed.limits.develop_budget_seconds, heartbeat: true, opensPr: false },
    { name: "review", budget: parsed.limits.review_budget_seconds, heartbeat: false, opensPr: false },
    { name: "pr", budget: parsed.limits.pr_budget_seconds, heartbeat: true, opensPr: true },
  ] as const;

  const belts: BeltConfig[] = parsed.belt.map((b) => {
    const sourceType = sourceTypeByName.get(b.source)!; // existence guaranteed by superRefine
    const base = {
      name: b.name,
      beltType: b.belt_type as BeltType,
      source: b.source,
      priority: b.priority,
      workspaceName: b.workspace_name,
      matchFile: b.match ? resolveFile(b.name, "match", b.match) : undefined,
    };
    if (b.belt_type === "work_to_pull_request") {
      const steps: StepConfig[] = PR_STEPS.map((d) => {
        const agent = b.agents[d.name];
        // schema guarantees prompt_file_source is present when prompt_file is.
        if (agent.prompt_file) checkConfigPromptFile(b.name, `${d.name} prompt_file`, agent.prompt_file_source!, agent.prompt_file);
        return {
          name: d.name,
          tab: agent.tab,
          pane: agent.pane,
          enginePrompt: shippedPrompt(sourceType, d.name),
          promptFile: agent.prompt_file,
          promptFileSource: agent.prompt_file_source,
          budgetSeconds: d.budget,
          heartbeat: d.heartbeat,
          opensPr: d.opensPr,
        };
      });
      return { ...base, steps, watchPr: true };
    }
    const steps: StepConfig[] = b.steps.map((s) => {
      checkConfigPromptFile(b.name, `step "${s.name}" prompt_file`, s.prompt_file_source, s.prompt_file);
      return {
        name: s.name,
        tab: s.tab,
        pane: s.pane,
        promptFile: s.prompt_file,
        promptFileSource: s.prompt_file_source,
        budgetSeconds: s.budget_seconds ?? parsed.limits.step_budget_seconds,
        heartbeat: s.heartbeat, // schema default: false
        opensPr: false,
      };
    });
    return { ...base, steps, watchPr: false };
  });
  // Stable sort: equal priorities keep config order (V8 Array.sort is stable on Node >=24).
  belts.sort((a, b) => a.priority - b.priority);

  const root = stateRoot();
  const stateDir = join(root, repoName);

  const config: Config = {
    repoName,
    repo: { path: repoPath, baseRef: parsed.repo.base_ref, github: parsed.repo.github },
    limits: {
      maxActive: parsed.limits.max_active,
      watchHours: parsed.limits.watch_hours,
      developBudgetSeconds: parsed.limits.develop_budget_seconds,
      stallSeconds: parsed.limits.stall_seconds,
      reviewBudgetSeconds: parsed.limits.review_budget_seconds,
      prBudgetSeconds: parsed.limits.pr_budget_seconds,
      stepBudgetSeconds: parsed.limits.step_budget_seconds,
      tickIntervalSeconds: parsed.limits.tick_interval_seconds,
      layoutWaitSeconds: parsed.limits.layout_wait_seconds,
    },
    sources,
    belts,
    guidance,
    paths: {
      configDir: cfgDir,
      repoDir,
      stateRoot: root,
      stateDir,
      dbPath: join(root, "herdr-factory.db"),
      logsDir: join(stateDir, "logs"),
    },
  };

  return { config, secrets: loadSecrets(repoDir) };
}
