import { appendFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./db/store.ts";
import { systemClock } from "./types.ts";
import { HerdrClient } from "./clients/herdr.ts";
import { JiraSource } from "./clients/jira-source.ts";
import { LocalMarkdownSource } from "./clients/local-markdown-source.ts";
import { GitHubClient } from "./clients/github.ts";
import { GitClient, parseGhRepo } from "./clients/git.ts";
import type { Deps, Logger, SourceRuntime } from "./core/deps.ts";

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function makeLogger(config: Config): Logger {
  mkdirSync(config.paths.logsDir, { recursive: true });
  return (level, msg) => {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(join(config.paths.logsDir, `${today()}.log`), line);
    } catch {
      /* logging to file is best-effort */
    }
  };
}

/** Construct the injected `Deps` for one repo: open the (shared) DB, build a live client per
 *  configured work source, wire the herdr/gh/git clients. Used by every CLI command's local
 *  fallback path AND by the resident server (once per repo it serves). */
export async function buildDeps(repoName: string): Promise<Deps> {
  const { config, secrets } = loadConfig(repoName);
  mkdirSync(config.paths.stateDir, { recursive: true });
  const store = new Store(openDb(config.paths.dbPath), systemClock);
  const git = new GitClient();
  const ghRepo = config.repo.github ?? parseGhRepo(await git.originUrl(config.repo.path)) ?? "";
  // config.sources is already priority-ordered; build a live client per source.
  const sources: SourceRuntime[] = config.sources.map((s) => ({
    name: s.name,
    type: s.type,
    priority: s.priority,
    workspaceName: s.workspaceName,
    agents: s.agents,
    client:
      s.type === "jira"
        ? new JiraSource(s.jira!, secrets.jiraEmail, secrets.jiraApiToken)
        : new LocalMarkdownSource(s.localMarkdown!.folder, store, repoName, s.name),
  }));
  const byName = new Map(sources.map((s) => [s.name, s]));
  return {
    config,
    secrets,
    store,
    ghRepo,
    herdr: new HerdrClient(process.env.HERDR_BIN_PATH ?? "herdr"),
    sources,
    resolveSource: (name) => (name == null ? undefined : byName.get(name)),
    github: new GitHubClient(),
    git,
    log: makeLogger(config),
    now: systemClock,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rmrf: (p) => rm(p, { recursive: true, force: true }),
  };
}
