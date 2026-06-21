import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Each pipeline agent (fix/review/pr) runs in its own herdr layout pane.
//   prompt_type: "augment" — the engine ships a sensible built-in prompt for the step and
//     appends `prompt_file` (optional here) as extra, repo-specific instructions.
//   prompt_type: "replace" — `prompt_file` (required here) is sent to the agent verbatim.
// prompt_type is REQUIRED with no default: "augment" is the recommended value, but it must
// be set explicitly so the prompt the agent receives is never a silent surprise.
const AgentSchema = z
  .object({
    // Where this step's agent runs. OPTIONAL, both-or-neither: when tab+pane are set the
    // dispatcher waits for the user's layout to bring that pane up (with an idle agent) and
    // delivers the prompt there — it never spawns its own. When omitted, it spawns a
    // dedicated pane itself. So set tab/pane for steps your herdr layout provisions; omit
    // them for steps you want herdr-factory to run on its own.
    tab: z.string().optional(),
    pane: z.string().optional(),
    prompt_type: z.enum(["augment", "replace"]),
    prompt_file: z.string().optional(),
  })
  .refine((a) => (a.tab == null) === (a.pane == null), {
    message: "tab and pane must be set together (or both omitted to spawn a dedicated pane)",
    path: ["pane"],
  })
  .refine((a) => a.prompt_type !== "replace" || !!a.prompt_file, {
    message: 'prompt_file is required when prompt_type is "replace"',
    path: ["prompt_file"],
  });

// The three pipeline agents — fix → review → pr — each in its own layout pane. All three
// required (no defaults). PER-SOURCE now: each work source has its own agent layout + prompts.
const AgentsSchema = z.object({ fix: AgentSchema, review: AgentSchema, pr: AgentSchema });

// A per-source branch-name template (the worktree + workspace derive from it). Must include
// {{ticket_id}} so each item gets a unique branch. Vars: {{ticket_id}} {{ticket_short_slug}}
// (<=20) {{ticket_slug}} (<=50) {{ticket_type}} {{ticket_prefix}} (fix|chore|feature).
const WorkspaceNameSchema = z
  .string()
  .refine((s) => /\{\{\s*ticket_id\s*\}\}/.test(s), {
    message: "workspace_name must include {{ticket_id}} so each item gets a unique branch",
  })
  .optional();

// The Jira source's where-to-poll block (per-source, so different sources can target different
// Atlassian sites/projects/boards). base_url is the Atlassian site (not a secret; auth — email
// + token — stays in the shared env). Same shape as the old top-level `jira` block.
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

// Fields shared by every work source, regardless of type.
const sourceBase = {
  // OPTIONAL identifier, default = type, must be unique within the repo (validated below). This
  // is what's stored on each run's `work_source` column. The pre-existing Jira source MUST keep
  // the default name "jira" so backfilled in-flight runs (migration v6) keep resolving. Trimmed
  // + non-empty when set, so a blank `name: ""` can't slip past the type-default / uniqueness.
  name: z.string().trim().min(1).optional(),
  // Lower = higher priority (pulled first when there are open slots). Ties break by config
  // order. Optional; defaults to 100 so an unprioritised source sorts after explicit ones.
  priority: z.coerce.number().int().default(100),
  workspace_name: WorkspaceNameSchema,
  agents: AgentsSchema,
};

const JiraSourceSchema = z.object({ type: z.literal("jira"), ...sourceBase, jira: JiraBlockSchema });
const LocalMarkdownSourceSchema = z.object({
  type: z.literal("local_markdown"),
  ...sourceBase,
  local_markdown: LocalMarkdownBlockSchema,
});
const WorkSourceSchema = z.discriminatedUnion("type", [JiraSourceSchema, LocalMarkdownSourceSchema]);

const RepoConfigSchema = z.object({
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
      tick_interval_seconds: z.coerce.number().int().positive().default(60),
      // How long to wait for a step's configured tab/pane to come up (with an idle agent)
      // before flagging the item for attention. Generous by default to allow the user's
      // layout setup + dev-server startup to finish; only applies to steps with a tab/pane.
      layout_wait_seconds: z.coerce.number().int().positive().default(600),
    })
    .prefault({}),
  // Where this repo pulls work from — an ordered, priority-ranked list of sources. Each source
  // owns its own workspace_name + agents + type-specific block. At least one is required.
  work_sources: z
    .array(WorkSourceSchema)
    .min(1, "work_sources must list at least one source")
    .superRefine((arr, ctx) => {
      // Validate uniqueness on the RESOLVED names (name ?? type) so two unnamed jira sources
      // correctly collide on "jira" rather than both passing as undefined.
      const seen = new Set<string>();
      arr.forEach((s, i) => {
        const name = s.name ?? s.type;
        if (seen.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate work source name "${name}" — give each source a unique name`,
            path: [i, "name"],
          });
        }
        seen.add(name);
      });
    }),
});

export interface Secrets {
  jiraEmail: string;
  jiraApiToken: string;
}

/** One pipeline agent's layout target + its resolved prompt. `prompt` is the final text the
 *  agent receives: in "augment" the engine default + any prompt_file additions, in "replace"
 *  the prompt_file verbatim. (Step tokens like @@KEY@@ are substituted later, at render time.) */
export interface AgentCfg {
  tab?: string;
  pane?: string;
  promptType: "augment" | "replace";
  promptFile: string; // resolved path, or "" when augment with no prompt_file
  prompt: string;
}

export type SourceType = "jira" | "local_markdown";

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

/** One configured work source: identity + per-source agents/workspace_name + the type block. */
export interface SourceConfig {
  name: string;
  type: SourceType;
  priority: number;
  workspaceName?: string;
  agents: { fix: AgentCfg; review: AgentCfg; pr: AgentCfg };
  jira?: JiraSourceCfg;
  localMarkdown?: LocalMarkdownSourceCfg;
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
    tickIntervalSeconds: number;
    layoutWaitSeconds: number;
  };
  sources: SourceConfig[]; // sorted by priority asc (ties: config order)
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

function configDir(): string {
  return process.env.HERDR_FACTORY_CONFIG_DIR ?? join(homedir(), ".config", "herdr-factory");
}
function stateRoot(): string {
  return process.env.HERDR_FACTORY_STATE_ROOT ?? join(homedir(), ".local", "state", "herdr-factory");
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

export function loadSecrets(): Secrets {
  const env = parseEnvFile(join(configDir(), "env"));
  return {
    jiraEmail: env.JIRA_EMAIL ?? "",
    jiraApiToken: env.JIRA_API_TOKEN ?? "",
  };
}

export function loadConfig(repoName: string): Loaded {
  const cfgDir = configDir();
  const repoDir = join(cfgDir, "repos", repoName);
  const ymlPath = join(repoDir, "config.yml");
  if (!existsSync(ymlPath)) {
    throw new Error(`no config for repo "${repoName}" at ${ymlPath}`);
  }

  const parsed = RepoConfigSchema.parse(parseYaml(readFileSync(ymlPath, "utf8")));
  const repoPath = expandHome(parsed.repo.path);
  assertMainCheckout(repoPath);

  const guidancePath = join(repoDir, "guidelines-prompt.md");
  const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, "utf8") : undefined;

  // Resolve one agent block into its layout target + final prompt text. The built-in prompt is
  // resolved per source type: prompts/<type>/<step>.md if present, else the shared prompts/<step>.md.
  const mkAgent = (a: z.infer<typeof AgentSchema>, label: string, sourceType: SourceType): AgentCfg => {
    let userPrompt = "";
    let promptFile = "";
    if (a.prompt_file) {
      promptFile = isAbsolute(a.prompt_file) ? a.prompt_file : join(repoDir, a.prompt_file);
      if (!existsSync(promptFile)) {
        throw new Error(`agents.${label}.prompt_file not found: ${promptFile}`);
      }
      userPrompt = readFileSync(promptFile, "utf8");
    }
    let prompt: string;
    if (a.prompt_type === "replace") {
      prompt = userPrompt; // schema guarantees prompt_file is present
    } else {
      // augment: engine default for this (source-type, step), plus any repo-specific additions.
      const typed = fileURLToPath(new URL(`prompts/${sourceType}/${label}.md`, import.meta.url));
      const shared = fileURLToPath(new URL(`prompts/${label}.md`, import.meta.url));
      const base = readFileSync(existsSync(typed) ? typed : shared, "utf8");
      prompt = userPrompt.trim()
        ? `${base.trimEnd()}\n\n## Additional repo-specific instructions for this step\n\n${userPrompt.trim()}\n`
        : base;
    }
    return { tab: a.tab, pane: a.pane, promptType: a.prompt_type, promptFile, prompt };
  };

  const sources: SourceConfig[] = parsed.work_sources.map((s) => {
    const agents = {
      fix: mkAgent(s.agents.fix, "fix", s.type),
      review: mkAgent(s.agents.review, "review", s.type),
      pr: mkAgent(s.agents.pr, "pr", s.type),
    };
    const base = {
      name: s.name ?? s.type,
      type: s.type,
      priority: s.priority,
      workspaceName: s.workspace_name,
      agents,
    };
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
  // Stable sort: equal priorities keep config order (V8 Array.sort is stable on Node >=24).
  sources.sort((a, b) => a.priority - b.priority);

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
      tickIntervalSeconds: parsed.limits.tick_interval_seconds,
      layoutWaitSeconds: parsed.limits.layout_wait_seconds,
    },
    sources,
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

  return { config, secrets: loadSecrets() };
}
