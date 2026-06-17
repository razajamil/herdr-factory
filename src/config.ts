import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
  worker: z
    .object({
      bootstrap_cmd: z.string().optional(),
      resolve_cmd: z.string().optional(),
      // herdr fix-layout tab/pane the worker is dispatched into (defaults main/agent).
      main_tab: z.string().default("main"),
      agent_pane: z.string().default("agent"),
    })
    .prefault({}),
  // Optional deterministic review pass. When present, the dispatcher inserts an
  // `auto_review` phase after the worker opens its PR: a dedicated review agent is
  // dispatched into tab/pane with prompt_file's CONTENTS as its prompt, and the ticket
  // is gated until it signals `review-done`. Omit the whole block to skip review.
  review: z
    .object({
      tab: z.string(),
      pane: z.string(),
      prompt_file: z.string(),
    })
    .optional(),
  limits: z
    .object({
      max_active: z.coerce.number().int().positive().default(3),
      watch_hours: z.coerce.number().positive().default(7),
      develop_budget_seconds: z.coerce.number().int().positive().default(5400),
      worker_done_grace_seconds: z.coerce.number().int().positive().default(1800),
      stall_seconds: z.coerce.number().int().positive().default(2700),
      review_budget_seconds: z.coerce.number().int().positive().default(1800),
      tick_interval_seconds: z.coerce.number().int().positive().default(60),
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
  workspaceName?: string;
  jira: {
    project: string;
    board: string;
    label: string;
    statusTodo: string;
    statusInDev: string;
    statusReview: string;
  };
  worker: { bootstrapCmd?: string; resolveCmd?: string; mainTab: string; agentPane: string };
  review?: { tab: string; pane: string; promptFile: string; prompt: string };
  limits: { maxActive: number; watchHours: number; developBudgetSeconds: number; workerDoneGraceSeconds: number; stallSeconds: number; reviewBudgetSeconds: number; tickIntervalSeconds: number };
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

  let review: Config["review"];
  if (parsed.review) {
    const promptFile = isAbsolute(parsed.review.prompt_file)
      ? parsed.review.prompt_file
      : join(repoDir, parsed.review.prompt_file);
    if (!existsSync(promptFile)) {
      throw new Error(`review.prompt_file not found: ${promptFile}`);
    }
    review = {
      tab: parsed.review.tab,
      pane: parsed.review.pane,
      promptFile,
      prompt: readFileSync(promptFile, "utf8"),
    };
  }

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
    worker: {
      bootstrapCmd: parsed.worker.bootstrap_cmd,
      resolveCmd: parsed.worker.resolve_cmd,
      mainTab: parsed.worker.main_tab,
      agentPane: parsed.worker.agent_pane,
    },
    review,
    limits: {
      maxActive: parsed.limits.max_active,
      watchHours: parsed.limits.watch_hours,
      developBudgetSeconds: parsed.limits.develop_budget_seconds,
      workerDoneGraceSeconds: parsed.limits.worker_done_grace_seconds,
      stallSeconds: parsed.limits.stall_seconds,
      reviewBudgetSeconds: parsed.limits.review_budget_seconds,
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
