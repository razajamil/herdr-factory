import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { globalDbPath, loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./db/store.ts";
import { systemClock, type Run, type StepName } from "./types.ts";
import { HerdrClient } from "./clients/herdr.ts";
import { JiraSource } from "./clients/jira-source.ts";
import { LocalMarkdownSource } from "./clients/local-markdown-source.ts";
import { GitHubClient } from "./clients/github.ts";
import { GitClient, parseGhRepo } from "./clients/git.ts";
import type { Deps, Logger, SourceRuntime } from "./core/deps.ts";
import { claimTicket, reconcileRepo, reconcileRun, teardownTicket, withTickLock } from "./core/reconcile.ts";
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

/** Resolve the source name for a manual command: the --source flag if given (validated), else
 *  the sole source, else fail asking which. */
function resolveSourceName(deps: Deps, optSource: string | undefined): string {
  if (optSource) {
    if (!deps.sources.some((s) => s.name === optSource)) {
      fail(`unknown source "${optSource}"; configured: ${deps.sources.map((s) => s.name).join(", ")}`);
    }
    return optSource;
  }
  if (deps.sources.length === 1) return deps.sources[0]!.name;
  fail(`multiple sources configured — pass --source <name> (one of: ${deps.sources.map((s) => s.name).join(", ")})`);
}

/** Resolve a single active run by key for a manual mutation, erroring on cross-source ambiguity. */
function resolveActiveRun(deps: Deps, key: string, optSource: string | undefined): Run | undefined {
  const repo = deps.config.repoName;
  if (optSource) return deps.store.activeRunForTicket(repo, optSource, key);
  const runs = deps.store.activeRunsForKey(repo, key);
  if (runs.length > 1) {
    fail(`${key}: active in multiple sources (${runs.map((r) => r.workSource).join(", ")}) — pass --source <name>`);
  }
  return runs[0];
}

const program = new Command();
program
  .name("herdr-factory")
  .description("Autonomous work→PR factory — runs Claude worker agents across repos on herdr worktrees.")
  .version("0.1.0")
  .option("--repo <name>", "target repo (its ~/.config/herdr-factory/repos/<name>/)");

function requireRepo(): string {
  const repo = (program.opts() as { repo?: string }).repo;
  if (!repo) fail("this command needs a repo: herdr-factory --repo <name> <command>");
  return repo;
}

program
  .command("tick")
  .description("run one reconcile pass (handy for manual/one-shot runs)")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const ran = await withTickLock(deps, () => reconcileRepo(deps));
      if (!ran) deps.log("info", "another tick is already running — skipping");
    } catch (e) {
      fail(e);
    }
  });

program
  .command("watch")
  .description("resident daemon: reconcile in a loop every tick_interval_seconds (what launchd keeps alive)")
  .action(async () => {
    let deps: Deps;
    try {
      deps = await buildDeps(requireRepo());
    } catch (e) {
      fail(e); // exits non-zero; launchd KeepAlive retries after ThrottleInterval
    }
    const intervalMs = deps.config.limits.tickIntervalSeconds * 1000;
    let stopping = false;
    const shutdown = (sig: string) => {
      if (stopping) return;
      stopping = true;
      deps.log("info", `watch: received ${sig}, stopping after the current pass`);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    deps.log("info", `watch: started — reconciling every ${deps.config.limits.tickIntervalSeconds}s`);
    while (!stopping) {
      try {
        const ran = await withTickLock(deps, () => reconcileRepo(deps));
        if (!ran) deps.log("info", "another tick is already running — skipping");
      } catch (e) {
        // A single failed pass must never kill the loop — log and keep polling.
        deps.log("error", `watch: tick failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      // Interruptible sleep, so SIGTERM (launchd bootout) stops us within ~1s.
      for (let waited = 0; waited < intervalMs && !stopping; waited += 1000) {
        await deps.sleep(Math.min(1000, intervalMs - waited));
      }
    }
    deps.log("info", "watch: stopped");
    process.exit(0);
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
        `    ${r.ticketKey.padEnd(16)} ${(r.workSource ?? "?").padEnd(14)} ${r.phase.padEnd(12)} ${statusCol.padEnd(16)} PR:${(r.prNumber ? `#${r.prNumber}` : "-").padEnd(6)} ${(r.summary ?? "").slice(0, 50)}`;
      console.log(`herdr-factory [${c.repoName}] — cap ${c.limits.maxActive}, watch ${c.limits.watchHours}h`);
      console.log(
        `Sources (priority order): ${c.sources.map((s) => `${s.name}(${s.type}, p${s.priority})`).join(" · ")}`,
      );
      console.log(`Runs: ${active.length} running (cap ${c.limits.maxActive}) · ${finished.length} finished`);
      console.log("");
      console.log(`  ACTIVE (${active.length})`);
      if (active.length === 0) console.log("    (none in flight)");
      for (const r of active) {
        // live worker status from herdr (what the cat is actually doing), vs the
        // ledger phase (where the loop thinks it is).
        const worker = r.paneId ? await deps.herdr.paneState(r.paneId) : "no-pane";
        console.log(fmt(r, `worker:${worker}`));
        const steps = deps.store.runStepsFor(r.id);
        if (steps.length) console.log(`      steps: ${steps.map((s) => `${s.step}${s.done ? "✓" : "●"}`).join(" ")}`);
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
  .description("list eligible (todo) work items across all sources")
  .action(async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const out: { source: string; key: string; summary: string; type: string }[] = [];
      for (const src of deps.sources) {
        try {
          for (const t of await src.client.listEligible()) out.push({ source: src.name, ...t });
        } catch (e) {
          deps.log("warn", `${src.name}: eligible query failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("claim <key>")
  .description("manually claim + start one work item")
  .option("--source <name>", "which work source the key belongs to (required if >1 source)")
  .action(async (key: string, opts: { source?: string }) => {
    try {
      const deps = await buildDeps(requireRepo());
      await claimTicket(deps, resolveSourceName(deps, opts.source), key);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("teardown <key>")
  .description("tear down one work item's worktree")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(async (key: string, opts: { source?: string }) => {
    try {
      await teardownTicket(await buildDeps(requireRepo()), key, opts.source);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("step-done <key> <step>")
  .description("a pipeline agent signals it finished its step (fix|review|pr)")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .action(async (key: string, step: string, opts: { source?: string }) => {
    try {
      if (!["fix", "review", "pr"].includes(step)) fail(`step-done: step must be fix|review|pr (got "${step}")`);
      const deps = await buildDeps(requireRepo());
      const run = resolveActiveRun(deps, key, opts.source);
      if (!run) {
        deps.log("warn", `${key}: no active run to mark step-done`);
        return;
      }
      deps.store.markStepDone(run.id, step as StepName);
      deps.store.recordEvent({ runId: run.id, repo: deps.config.repoName, ticketKey: key, type: "step_done", detail: { step } });
      deps.log("info", `${key}: step-done ${step} recorded`);
      // Event nudge: advance the run immediately if no tick is mid-flight; otherwise the
      // in-flight/next tick picks up the done flag. The tick is the backstop.
      const ran = await withTickLock(deps, () => reconcileRun(deps, deps.store.getRun(run.id)!));
      if (!ran) deps.log("info", `${key}: tick busy — next tick will advance the pipeline`);
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
      console.log(`installed + loaded ${launchd.label(deps.config.repoName)} (resident watch, reconciles every ${deps.config.limits.tickIntervalSeconds}s)`);
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
      for (const src of deps.sources) {
        await check(`source ${src.name} (${src.type})`, () => src.client.health());
      }
      await check("git origin resolved", async () => {
        if (!deps.ghRepo) throw new Error("no origin");
      });
      console.log(`db: ${deps.config.paths.dbPath}`);
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync().catch(fail);
