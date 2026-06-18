import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Each pipeline agent (fix/review/pr) runs in its own herdr layout pane and is
// driven by its own prompt file. All fields required — no defaults.
const AgentSchema = z.object({
  tab: z.string(),
  pane: z.string(),
  prompt_file: z.string(),
});

const RepoConfigSchema = z.object({
  repo: z.object({
    path: z.string(),
    base_ref: z.string().default("origin/main"),
    github: z.string().optional(),
  }),
  // Branch-name template for each cat; the worktree + workspace derive from it.
  // Vars: {{ticket_id}} {{ticket_short_slug}} {{ticket_slug}} {{ticket_type}} {{ticket_prefix}}.
  workspace_name: z
    .string()
    .refine((s) => /\{\{\s*ticket_id\s*\}\}/.test(s), {
      message: "workspace_name must include {{ticket_id}} so each ticket gets a unique branch",
    })
    .optional(),
  jira: z.object({
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
  }),
  // The three pipeline agents — fix → review → pr — each in its own layout pane,
  // each with its own prompt file. All three required (no defaults). Per-repo
  // bootstrap/resolve guidance now lives inside these prompt files.
  agents: z.object({
    fix: AgentSchema,
    review: AgentSchema,
    pr: AgentSchema,
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
    })
    .prefault({}),
});

export interface Secrets {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
}

/** One pipeline agent's layout target + its rendered prompt (file contents). */
export interface AgentCfg {
  tab: string;
  pane: string;
  promptFile: string;
  prompt: string;
}

export interface Config {
  repoName: string;
  repo: { path: string; baseRef: string; github?: string };
  workspaceName?: string;
  jira: {
    project: string;
    board: string;
    label: string;
    statusTodo: string;
    statusInDev: string;
    statusReview: string;
  };
  agents: { fix: AgentCfg; review: AgentCfg; pr: AgentCfg };
  limits: { maxActive: number; watchHours: number; developBudgetSeconds: number; stallSeconds: number; reviewBudgetSeconds: number; prBudgetSeconds: number; tickIntervalSeconds: number };
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
    jiraBaseUrl: (env.JIRA_BASE_URL ?? "").replace(/\/+$/, ""),
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
  assertMainCheckout(parsed.repo.path);

  const guidancePath = join(repoDir, "guidelines-prompt.md");
  const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, "utf8") : undefined;

  const mkAgent = (a: z.infer<typeof AgentSchema>, label: string): AgentCfg => {
    const promptFile = isAbsolute(a.prompt_file) ? a.prompt_file : join(repoDir, a.prompt_file);
    if (!existsSync(promptFile)) {
      throw new Error(`agents.${label}.prompt_file not found: ${promptFile}`);
    }
    return { tab: a.tab, pane: a.pane, promptFile, prompt: readFileSync(promptFile, "utf8") };
  };

  const root = stateRoot();
  const stateDir = join(root, repoName);

  const config: Config = {
    repoName,
    repo: { path: parsed.repo.path, baseRef: parsed.repo.base_ref, github: parsed.repo.github },
    workspaceName: parsed.workspace_name,
    jira: {
      project: parsed.jira.project,
      board: parsed.jira.board,
      label: parsed.jira.label,
      statusTodo: parsed.jira.status.todo,
      statusInDev: parsed.jira.status.in_development,
      statusReview: parsed.jira.status.review,
    },
    agents: {
      fix: mkAgent(parsed.agents.fix, "fix"),
      review: mkAgent(parsed.agents.review, "review"),
      pr: mkAgent(parsed.agents.pr, "pr"),
    },
    limits: {
      maxActive: parsed.limits.max_active,
      watchHours: parsed.limits.watch_hours,
      developBudgetSeconds: parsed.limits.develop_budget_seconds,
      stallSeconds: parsed.limits.stall_seconds,
      reviewBudgetSeconds: parsed.limits.review_budget_seconds,
      prBudgetSeconds: parsed.limits.pr_budget_seconds,
      tickIntervalSeconds: parsed.limits.tick_interval_seconds,
    },
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
