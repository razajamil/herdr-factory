import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const RepoConfigSchema = z.object({
  repo: z.object({
    path: z.string(),
    base_ref: z.string().default("origin/main"),
    github: z.string().optional(),
  }),
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
  worker: z
    .object({
      bootstrap_cmd: z.string().optional(),
      deslop_cmd: z.string().optional(),
      resolve_cmd: z.string().optional(),
    })
    .prefault({}),
  layout: z
    .object({
      main_tab: z.string().default("main"),
      agent_pane: z.string().default("agent"),
    })
    .prefault({}),
  limits: z
    .object({
      max_active: z.coerce.number().int().positive().default(3),
      watch_hours: z.coerce.number().positive().default(7),
      develop_budget_seconds: z.coerce.number().int().positive().default(5400),
      tick_interval_seconds: z.coerce.number().int().positive().default(180),
    })
    .prefault({}),
});

export interface Secrets {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
}

export interface Config {
  repoName: string;
  repo: { path: string; baseRef: string; github?: string };
  jira: {
    project: string;
    board: string;
    label: string;
    statusTodo: string;
    statusInDev: string;
    statusReview: string;
  };
  worker: { bootstrapCmd?: string; deslopCmd?: string; resolveCmd?: string };
  layout: { mainTab: string; agentPane: string };
  limits: { maxActive: number; watchHours: number; developBudgetSeconds: number; tickIntervalSeconds: number };
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
  return process.env.HERDR_CATS_CONFIG_DIR ?? join(homedir(), ".config", "herdr-cats");
}
function stateRoot(): string {
  return process.env.HERDR_CATS_STATE_ROOT ?? join(homedir(), ".local", "state", "herdr-cats");
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
  return join(stateRoot(), "herdr-cats.db");
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

  const root = stateRoot();
  const stateDir = join(root, repoName);

  const config: Config = {
    repoName,
    repo: { path: parsed.repo.path, baseRef: parsed.repo.base_ref, github: parsed.repo.github },
    jira: {
      project: parsed.jira.project,
      board: parsed.jira.board,
      label: parsed.jira.label,
      statusTodo: parsed.jira.status.todo,
      statusInDev: parsed.jira.status.in_development,
      statusReview: parsed.jira.status.review,
    },
    worker: {
      bootstrapCmd: parsed.worker.bootstrap_cmd,
      deslopCmd: parsed.worker.deslop_cmd,
      resolveCmd: parsed.worker.resolve_cmd,
    },
    layout: { mainTab: parsed.layout.main_tab, agentPane: parsed.layout.agent_pane },
    limits: {
      maxActive: parsed.limits.max_active,
      watchHours: parsed.limits.watch_hours,
      developBudgetSeconds: parsed.limits.develop_budget_seconds,
      tickIntervalSeconds: parsed.limits.tick_interval_seconds,
    },
    guidance,
    paths: {
      configDir: cfgDir,
      repoDir,
      stateRoot: root,
      stateDir,
      dbPath: join(root, "herdr-cats.db"),
      logsDir: join(stateDir, "logs"),
    },
  };

  return { config, secrets: loadSecrets() };
}
