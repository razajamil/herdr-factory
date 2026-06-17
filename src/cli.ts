import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { globalDbPath, loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./db/store.ts";
import { systemClock, type Run } from "./types.ts";
import { HerdrClient } from "./clients/herdr.ts";
import { JiraClient } from "./clients/jira.ts";
import { GitHubClient } from "./clients/github.ts";
import { GitClient, parseGhRepo } from "./clients/git.ts";
import type { Deps, Logger } from "./core/deps.ts";
import { claimTicket, reconcileRepo, teardownTicket } from "./core/reconcile.ts";
import { run } from "./clients/exec.ts";
import * as launchd from "./launchd.ts";

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeLogger(config: Config): Logger {
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

async function buildDeps(repoName: string): Promise<Deps> {
  const { config, secrets } = loadConfig(repoName);
  mkdirSync(config.paths.stateDir, { recursive: true });
  const store = new Store(openDb(config.paths.dbPath), systemClock);
  const git = new GitClient();
  const ghRepo = config.repo.github ?? parseGhRepo(await git.originUrl(config.repo.path)) ?? "";
  return {
    config,
    secrets,
    store,
    ghRepo,
    herdr: new HerdrClient(process.env.HERDR_BIN_PATH ?? "herdr"),
    jira: new JiraClient(secrets.jiraBaseUrl, secrets.jiraEmail, secrets.jiraApiToken),
    github: new GitHubClient(),
    git,
    log: makeLogger(config),
    now: systemClock,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const program = new Command();
program
  .name("herdr-cats")
  .description('Autonomous Jira→PR loop that herds Claude worker agents ("cats") across repos.')
  .version("0.1.0")
  .option("--repo <name>", "target repo (its ~/.config/herdr-cats/repos/<name>/)");

function requireRepo(): string {
  const repo = (program.opts() as { repo?: string }).repo;
  if (!repo) fail("this command needs a repo: herdr-cats --repo <name> <command>");
  return repo;
}

program
  .command("tick")
  .description("run one reconcile pass (what launchd invokes)")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const owner = `pid:${process.pid}`;
      if (!deps.store.acquireLock(`tick:${deps.config.repoName}`, owner, deps.config.limits.tickIntervalSeconds * 2)) {
        deps.log("info", "another tick is already running — skipping");
        return;
      }
      try {
        await reconcileRepo(deps);
      } finally {
        deps.store.releaseLock(`tick:${deps.config.repoName}`, owner);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("status")
  .description("show active tickets + launchd state for the repo")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const c = deps.config;
      const active = deps.store.activeRuns(c.repoName);
      const recent = deps.store.listRuns(c.repoName, true);
      const finished = recent.filter((r) => r.endedAt !== null);
      const fmt = (r: Run, statusCol: string) =>
        `    ${`cat:${r.ticketKey}`.padEnd(16)} ${r.phase.padEnd(12)} ${statusCol.padEnd(16)} PR:${(r.prNumber ? `#${r.prNumber}` : "-").padEnd(6)} ${(r.summary ?? "").slice(0, 60)}`;
      console.log(
        `herdr-cats [${c.repoName}] — board ${c.jira.board}, label "${c.jira.label}", cap ${c.limits.maxActive}, watch ${c.limits.watchHours}h`,
      );
      console.log(`Cats: ${active.length} running (cap ${c.limits.maxActive}) · ${finished.length} finished`);
      console.log("");
      console.log(`  ACTIVE (${active.length})`);
      if (active.length === 0) console.log("    (none in flight)");
      for (const r of active) {
        // live worker status from herdr (what the cat is actually doing), vs the
        // ledger phase (where the loop thinks it is).
        const worker = r.paneId ? await deps.herdr.paneState(r.paneId) : "no-pane";
        console.log(fmt(r, `worker:${worker}`));
      }
      if (finished.length) {
        console.log("");
        console.log(`  FINISHED (${finished.length}${recent.length >= 100 ? ", latest 100" : ""}, newest first)`);
        for (const r of finished) console.log(fmt(r, r.outcome ?? "—"));
      }
      console.log("");
      console.log(`launchd: ${(await launchd.isLoaded(c.repoName)) ? "loaded" : "not loaded"}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("eligible")
  .description("list eligible To-Do + agent-labelled tickets")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const tickets = await deps.jira.listEligible(deps.config.jira.board, deps.config.jira.label, deps.config.jira.statusTodo);
      console.log(JSON.stringify(tickets, null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("claim <key>")
  .description("manually claim + start one ticket")
  .action(async (key: string) => {
    try {
      await claimTicket(await buildDeps(requireRepo()), key);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("teardown <key>")
  .description("tear down one ticket's worktree")
  .action(async (key: string) => {
    try {
      await teardownTicket(await buildDeps(requireRepo()), key);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("worker-done <key>")
  .description("worker signals it has finished its automated round")
  .action(async (key: string) => {
    try {
      const deps = await buildDeps(requireRepo());
      const run = deps.store.activeRunForTicket(deps.config.repoName, key);
      if (!run) {
        deps.log("warn", `${key}: no active run to mark worker-done`);
        return;
      }
      deps.store.updateRun(run.id, { workerDone: true });
      deps.store.recordEvent({ runId: run.id, repo: deps.config.repoName, ticketKey: key, type: "worker_done" });
      deps.log("info", `${key}: worker-done recorded`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("runs")
  .description("list runs for the repo")
  .option("--all", "include finished runs")
  .action(async (opts: { all?: boolean }) => {
    try {
      const deps = await buildDeps(requireRepo());
      for (const r of deps.store.listRuns(deps.config.repoName, !!opts.all)) {
        console.log(
          `#${String(r.id).padEnd(4)} ${r.ticketKey.padEnd(12)} ${r.phase.padEnd(12)} ${(r.outcome ?? "").padEnd(9)} PR:${r.prNumber ?? "-"} ${r.branch ?? ""}`,
        );
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("timeline <key>")
  .description("show the event timeline for a ticket")
  .action(async (key: string) => {
    try {
      const deps = await buildDeps(requireRepo());
      for (const ev of deps.store.timeline(deps.config.repoName, key)) {
        console.log(`${new Date(ev.ts * 1000).toISOString()}  ${ev.type}${ev.detail ? `  ${ev.detail}` : ""}`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("capture-lock <action> [owner]")
  .description("machine-global dev-server/screenshot lock (acquire|release)")
  .action(async (act: string, owner = "worker") => {
    try {
      const dbPath = globalDbPath();
      mkdirSync(dirname(dbPath), { recursive: true });
      const store = new Store(openDb(dbPath), systemClock);
      if (act === "acquire") {
        const deadline = Date.now() + 3_600_000;
        for (;;) {
          if (store.acquireLock("capture", owner, 1200)) {
            console.log(`capture lock acquired by ${owner}`);
            return;
          }
          if (Date.now() > deadline) fail("timed out waiting for capture lock");
          await new Promise((r) => setTimeout(r, 5000));
        }
      } else if (act === "release") {
        store.releaseLock("capture", owner);
        console.log(`capture lock released by ${owner}`);
      } else {
        fail("capture-lock: acquire|release <owner>");
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("install")
  .description("install the repo's launchd job")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      await launchd.install(deps.config);
      console.log(`installed + loaded ${launchd.label(deps.config.repoName)} (every ${deps.config.limits.tickIntervalSeconds}s)`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("uninstall")
  .description("remove the repo's launchd job")
  .action(async () => {
    try {
      const repo = requireRepo();
      await launchd.uninstall(repo);
      console.log(`uninstalled ${launchd.label(repo)} (in-flight workers untouched)`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("start")
  .description("load the repo's launchd job")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      await launchd.start(deps.config);
      console.log(`started ${launchd.label(deps.config.repoName)}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("stop")
  .description("unload the repo's launchd job (workers keep running)")
  .action(async () => {
    try {
      const repo = requireRepo();
      await launchd.stop(repo);
      console.log(`stopped ${launchd.label(repo)}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("logs [n]")
  .description("tail today's log for the repo")
  .action(async (n?: string) => {
    try {
      const deps = await buildDeps(requireRepo());
      const file = join(deps.config.paths.logsDir, `${today()}.log`);
      if (!existsSync(file)) {
        console.log(`no log for today at ${file}`);
        return;
      }
      const lines = readFileSync(file, "utf8").split("\n");
      console.log(lines.slice(-(Number(n) || 50)).join("\n"));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("doctor")
  .description("check herdr, gh, jira auth, db, and claude on PATH")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
      const check = async (name: string, fn: () => Promise<unknown>) => {
        let ok = true;
        try {
          await fn();
        } catch {
          ok = false;
        }
        console.log(`${ok ? "✓" : "✗"} ${name}`);
      };
      await check("herdr socket", () => run(herdrBin, ["workspace", "list"]));
      await check("gh auth", () => run("gh", ["auth", "status"]));
      await check("claude on PATH", () => run("claude", ["--version"]));
      await check("jira auth", () =>
        deps.jira.listEligible(deps.config.jira.board, deps.config.jira.label, deps.config.jira.statusTodo),
      );
      await check("git origin resolved", async () => {
        if (!deps.ghRepo) throw new Error("no origin");
      });
      console.log(`db: ${deps.config.paths.dbPath}`);
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync().catch(fail);
