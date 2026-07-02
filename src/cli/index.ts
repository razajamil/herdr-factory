import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { configJsonSchema, configSchemaPath, globalDbPath, nodePathFile, writeConfigSchema } from "../config.ts";
import { openDb } from "../db/index.ts";
import { Store } from "../db/store.ts";
import { systemClock, type Run } from "../types.ts";
import type { Deps } from "../core/deps.ts";
import { claimTicket, reconcileRepo, reconcileRun, requestHumanInput, teardownTicket, withTickLock } from "../core/reconcile.ts";
import { stepByName } from "../core/step.ts";
import { run } from "../clients/exec.ts";
import * as launchd from "../watchers/launchd.ts";
import { buildDeps, today } from "../build-deps.ts";
import { resolveActiveRun, resolveBeltName } from "../resolve.ts";
import { serve } from "../server/serve.ts";
import { ensureUp, stopServer, type Log } from "../watchers/supervisor.ts";
import { selfUpdate } from "../watchers/updater.ts";
import { NoServerError, pingHealth, readServerInfo, serverFetch, viaServerOrLocal } from "../server/client.ts";
import { VERSION } from "../version.ts";
import { initTelemetry, recordCliDuration, shutdownTelemetry, telemetryEnabled, telemetryEvent, telemetrySpan } from "../telemetry/index.ts";
import { disposeEffectRuntime } from "../runtime/effect.ts";

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

/** Record this node binary so `bin/herdr-factory` can re-exec with a known Node >=24 from any cwd
 *  (see config.nodePathFile). Best-effort + guarded to >=24 so we never bake an unusable path (the
 *  CLI effectively only ever runs under >=24 anyway — type-stripping + node:sqlite require it).
 *  Runs on every invocation, so it self-heals as the pinned node is upgraded. */
function bakeNodePath(): void {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) return;
    const file = nodePathFile();
    if (existsSync(file) && readFileSync(file, "utf8") === process.execPath) return;
    mkdirSync(dirname(file), { recursive: true });
    // Atomic publish (write sibling temp, then rename) so a concurrent launcher `cat` never reads a
    // torn/empty file — writeFileSync truncates first, and multiple workers can bake at once.
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, process.execPath);
    renameSync(tmp, file);
  } catch {
    /* best-effort: a read-only / uncreatable state dir must never break the CLI */
  }
}
bakeNodePath();
initTelemetry();

async function shutdownRuntimes(): Promise<void> {
  await Promise.all([shutdownTelemetry(), disposeEffectRuntime()]);
}

/** A console logger for the repo-agnostic supervisor commands (serve/ensure-up/install/…). */
const consoleLog: Log = (level, msg) => console.log(`[${level}] ${msg}`);
let residentCommand = false;

const program = new Command();
program
  .name("herdr-factory")
  .description("Autonomous work→PR factory — runs Claude worker agents across repos on herdr worktrees.")
  .version(VERSION)
  .option("--repo <name>", "target repo (its ~/.config/herdr-factory/repos/<name>/)");

function requireRepo(): string {
  const repo = (program.opts() as { repo?: string }).repo;
  if (!repo) fail("this command needs a repo: herdr-factory --repo <name> <command>");
  return repo;
}

function humanQuestionText(opts: { question?: string; questionFile?: string }): string {
  if (opts.question && opts.questionFile) fail("ask-human: pass either --question or --question-file, not both");
  const text = opts.questionFile ? readFileSync(opts.questionFile, "utf8") : opts.question;
  if (!text?.trim()) fail("ask-human: provide a non-empty --question or --question-file");
  return text.trim();
}

function cliAction<Args extends unknown[]>(name: string, fn: (...args: Args) => Promise<void> | void): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    const startedAt = Date.now();
    const repo = (program.opts() as { repo?: string }).repo;
    await telemetrySpan("cli.command", { "cli.command": name, repo }, async () => {
      try {
        await fn(...args);
      } finally {
        recordCliDuration(Date.now() - startedAt, { "cli.command": name, repo });
      }
    });
  };
}

program
  .command("telemetry-smoke")
  .description("emit a small OpenTelemetry trace/metric to verify local telemetry export")
  .action(cliAction("telemetry-smoke", async () => {
    if (!telemetryEnabled()) {
      console.log("telemetry disabled — set HERDR_FACTORY_TELEMETRY=1 and OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318");
      return;
    }
    await telemetrySpan("telemetry.smoke", {}, async () => {
      telemetryEvent("telemetry.smoke.event", { ok: true });
    });
    console.log("telemetry smoke trace emitted (service: herdr-factory, trace root: cli.command)");
  }));

program
  .command("tick")
  .description("run one reconcile pass (routes through the server if up, else runs in-process)")
  .action(cliAction("tick", async () => {
    try {
      const repo = requireRepo();
      const { viaServer, data } = await viaServerOrLocal({ method: "POST", path: `/repos/${encodeURIComponent(repo)}/tick` }, async () => {
        const deps = await buildDeps(repo);
        const ran = await withTickLock(deps, () => reconcileRepo(deps));
        if (!ran) deps.log("info", "another tick is already running — skipping");
        return { ran };
      });
      const ran = (data as { ran?: boolean }).ran;
      console.log(`tick: ${ran === false ? "another tick already running" : "ran"} (${viaServer ? "via server" : "in-process"})`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("watch")
  .description("[legacy/dev] single-repo resident loop (the server now does this for all repos)")
  .action(cliAction("watch", async () => {
    residentCommand = true;
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
    await shutdownRuntimes();
    process.exit(0);
  }));

program
  .command("status")
  .description("show active tickets + server/supervisor state for the repo")
  .action(cliAction("status", async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const c = deps.config;
      const active = deps.store.activeRuns(c.repoName);
      const recent = deps.store.listRuns(c.repoName, true);
      const finished = recent.filter((r) => r.endedAt !== null);
      // The phase column shows the active step when running (phase is just "running" otherwise).
      const fmt = (r: Run, statusCol: string) =>
        `    ${r.ticketKey.padEnd(16)} ${(r.belt ?? "?").padEnd(16)} ${(r.phase === "running" && r.step ? r.step : r.phase).padEnd(12)} ${statusCol.padEnd(16)} PR:${(r.prNumber ? `#${r.prNumber}` : "-").padEnd(6)} ${(r.summary ?? "").slice(0, 50)}`;
      console.log(`herdr-factory [${c.repoName}] — cap ${c.limits.maxActive}, watch ${c.limits.watchHours}h`);
      console.log(`Sources: ${c.sources.map((s) => `${s.name}(${s.type})`).join(" · ")}`);
      console.log(
        `Belts (priority order): ${c.belts.map((b) => `${b.name}(${b.beltType}, src:${b.source}, p${b.priority})`).join(" · ")}`,
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
      const info = readServerInfo();
      const healthy = info ? await pingHealth(info.port) : false;
      console.log(
        `server: ${healthy ? `running (pid ${info!.pid}, port ${info!.port}, v${info!.version})` : info ? "advertised but not responding" : "not running"}`,
      );
      console.log(`supervisor: ${(await launchd.isLoaded()) ? "loaded" : "not loaded"}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("eligible")
  .description("list eligible (todo) work items across all sources")
  .action(cliAction("eligible", async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const out: { source: string; key: string; summary: string; type: string }[] = [];
      for (const src of deps.sources) {
        try {
          for (const t of await src.client.listEligible()) out.push({ source: src.name, key: t.key, summary: t.summary, type: t.type });
        } catch (e) {
          deps.log("warn", `${src.name}: eligible query failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("claim <key>")
  .description("manually claim + start one work item on a belt")
  .option("--belt <name>", "which belt to run the item on (required if >1 belt)")
  .action(cliAction("claim", async (key: string, opts: { belt?: string }) => {
    try {
      const repo = requireRepo();
      await viaServerOrLocal({ method: "POST", path: `/repos/${encodeURIComponent(repo)}/claim`, body: { key, belt: opts.belt } }, async () => {
        const deps = await buildDeps(repo);
        await claimTicket(deps, resolveBeltName(deps, opts.belt), key);
        return { ok: true };
      });
      console.log(`${key}: claimed`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("teardown <key>")
  .description("tear down one work item's worktree")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(cliAction("teardown", async (key: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      await viaServerOrLocal({ method: "POST", path: `/repos/${encodeURIComponent(repo)}/teardown`, body: { key, source: opts.source } }, async () => {
        await teardownTicket(await buildDeps(repo), key, opts.source);
        return { ok: true };
      });
      console.log(`${key}: torn down`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("step-done <key> <step>")
  .description("a belt agent signals it finished its step — event-nudges the dispatcher")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .action(cliAction("step-done", async (key: string, step: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      // Route through the server (warm reconcile in ~ms) with a direct in-process fallback so the
      // nudge still lands while the server is restarting — the next tick is the backstop either way.
      const { data } = await viaServerOrLocal(
        { method: "POST", path: `/repos/${encodeURIComponent(repo)}/step-done`, body: { key, step, source: opts.source } },
        async () => {
          const deps = await buildDeps(repo);
          const run = resolveActiveRun(deps, key, opts.source);
          if (!run) {
            deps.log("warn", `${key}: no active run to mark step-done`);
            return { ok: false, message: "no active run" };
          }
          // The valid step set is belt-specific; reject a step that isn't part of the run's belt.
          const belt = deps.resolveBelt(run.belt);
          if (belt && !stepByName(belt, step)) {
            deps.log("warn", `${key}: step "${step}" is not in belt "${belt.name}"`);
            return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
          }
          deps.store.markStepDone(run.id, step);
          deps.store.recordEvent({ runId: run.id, repo: deps.config.repoName, ticketKey: key, type: "step_done", detail: { step } });
          deps.log("info", `${key}: step-done ${step} recorded`);
          const advanced = await withTickLock(deps, () => reconcileRun(deps, deps.store.getRun(run.id)!));
          if (!advanced) deps.log("info", `${key}: tick busy — next tick will advance the belt`);
          return { ok: true, advanced };
        },
      );
      const d = data as { ok?: boolean; message?: string };
      if (d.ok === false) console.log(`${key}: ${d.message ?? "no active run"}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("ask-human <key> <step>")
  .description("a belt agent asks a human through the work source and pauses until a reply arrives")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .option("--question <text>", "question text")
  .option("--question-file <path>", "file containing the question text")
  .action(cliAction("ask-human", async (key: string, step: string, opts: { source?: string; question?: string; questionFile?: string }) => {
    try {
      const repo = requireRepo();
      const question = humanQuestionText(opts);
      const { data } = await viaServerOrLocal(
        { method: "POST", path: `/repos/${encodeURIComponent(repo)}/ask-human`, body: { key, step, source: opts.source, question } },
        async () => {
          const deps = await buildDeps(repo);
          const run = resolveActiveRun(deps, key, opts.source);
          if (!run) {
            deps.log("warn", `${key}: no active run to ask human`);
            return { ok: false, message: "no active run" };
          }
          const belt = deps.resolveBelt(run.belt);
          if (belt && !stepByName(belt, step)) {
            deps.log("warn", `${key}: step "${step}" is not in belt "${belt.name}"`);
            return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
          }
          const result = await requestHumanInput(deps, run, step, question);
          const advanced = await withTickLock(deps, () => reconcileRun(deps, deps.store.getRun(run.id)!));
          if (!advanced) deps.log("info", `${key}: tick busy — next tick will poll for a human reply`);
          return result;
        },
      );
      const d = data as { ok?: boolean; questionId?: number; posted?: boolean; message?: string };
      if (d.ok === false) {
        console.log(`${key}: ${d.message ?? "no active run"}`);
        return;
      }
      console.log(`${key}: waiting for human answer (question #${d.questionId}${d.posted ? "" : ", posting deferred"})`);
      if (d.message) console.log(d.message);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("runs")
  .description("list runs for the repo")
  .option("--all", "include finished runs")
  .action(cliAction("runs", async (opts: { all?: boolean }) => {
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
  }));

program
  .command("timeline <key>")
  .description("show the event timeline for a ticket")
  .action(cliAction("timeline", async (key: string) => {
    try {
      const deps = await buildDeps(requireRepo());
      for (const ev of deps.store.timeline(deps.config.repoName, key)) {
        console.log(`${new Date(ev.ts * 1000).toISOString()}  ${ev.type}${ev.detail ? `  ${ev.detail}` : ""}`);
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("capture-lock <action> [owner]")
  .description("machine-global dev-server/screenshot lock (acquire|release)")
  .action(cliAction("capture-lock", async (act: string, owner = "worker") => {
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
  }));

program
  .command("serve")
  .description("run the resident server: tick every configured repo + expose the HTTP API (kept alive by the supervisor)")
  .action(cliAction("serve", async () => {
    residentCommand = true;
    try {
      await serve();
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("ensure-up")
  .description("[supervisor] one-shot: (re)start the server if it's down/wedged/outdated, then exit (what launchd schedules)")
  .option("--restart", "force a graceful restart even if the server is healthy")
  .action(cliAction("ensure-up", async (opts: { restart?: boolean }) => {
    try {
      const { action } = await ensureUp({ force: opts.restart }, consoleLog);
      console.log(`ensure-up: ${action}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("restart")
  .description("gracefully restart the running server (picks up new code after a pull)")
  .action(cliAction("restart", async () => {
    try {
      const { action } = await ensureUp({ force: true }, consoleLog);
      console.log(`restart: ${action}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("update")
  .description("pull the latest code (hard reset to upstream) and restart the server onto it")
  .action(cliAction("update", async () => {
    try {
      const res = await selfUpdate(consoleLog);
      if (!res.updated) {
        console.log(`no update: ${res.reason}`);
        return;
      }
      console.log(`updated ${res.from?.slice(0, 12)} → ${res.to?.slice(0, 12)}; restarting server`);
      const { action } = await ensureUp({ force: true, skipAutoUpdate: true }, consoleLog);
      console.log(`restart: ${action}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("reload")
  .description("hot-reload config: the running server re-reads every repo's config + re-discovers repos (no restart)")
  .action(cliAction("reload", async () => {
    try {
      const data = await serverFetch("POST", "/reload");
      const repos = (data as { repos?: string[] }).repos ?? [];
      console.log(`reloaded — serving: ${repos.join(", ") || "(no repos)"}`);
    } catch (e) {
      if (e instanceof NoServerError) {
        console.log("no server running — config is read fresh on the next `serve` start (try `herdr-factory start`)");
        return;
      }
      fail(e);
    }
  }));

program
  .command("schema")
  .description("write the config.yml JSON Schema (editor autocomplete + validation) to <configDir>/config.schema.json")
  .option("--stdout", "print the schema to stdout instead of writing the file")
  .action(cliAction("schema", (opts: { stdout?: boolean }) => {
    try {
      if (opts.stdout) {
        console.log(JSON.stringify(configJsonSchema(), null, 2));
        return;
      }
      console.log(`wrote ${writeConfigSchema()}`);
      console.log("add this first line to a repo's config.yml so your editor uses it:");
      console.log("  # yaml-language-server: $schema=../../config.schema.json");
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("install")
  .description("install the machine-wide supervisor (one launchd job that keeps the server up for all repos)")
  .action(cliAction("install", async () => {
    try {
      writeConfigSchema(); // keep the editor schema current with this version's config shape
      await launchd.install();
      await ensureUp({}, consoleLog);
      console.log(`installed + loaded ${launchd.label()} — scheduled ensure-up keeps the server serving all configured repos`);
      console.log(`config schema at ${configSchemaPath()} (reference it with: # yaml-language-server: $schema=../../config.schema.json)`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("uninstall")
  .description("remove the supervisor job and stop the server (in-flight workers untouched)")
  .action(cliAction("uninstall", async () => {
    try {
      await launchd.uninstall();
      await stopServer(consoleLog);
      console.log(`uninstalled ${launchd.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("start")
  .description("load the supervisor job (and bring the server up)")
  .action(cliAction("start", async () => {
    try {
      await launchd.start();
      await ensureUp({}, consoleLog);
      console.log(`started ${launchd.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("stop")
  .description("unload the supervisor job and stop the server (workers keep running)")
  .action(cliAction("stop", async () => {
    try {
      await launchd.stop();
      await stopServer(consoleLog);
      console.log(`stopped ${launchd.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("logs [n]")
  .description("tail today's log for the repo")
  .action(cliAction("logs", async (n?: string) => {
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
  }));

program
  .command("doctor")
  .description("check herdr, gh, jira auth, db, and claude on PATH")
  .action(cliAction("doctor", async () => {
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
      const info = readServerInfo();
      console.log(`server: ${info && (await pingHealth(info.port)) ? `running on :${info.port} (v${info.version})` : "not running"}`);
      console.log(`db: ${deps.config.paths.dbPath}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .parseAsync()
  .then(async () => {
    if (!residentCommand) await shutdownRuntimes();
  })
  .catch(async (e) => {
    await shutdownRuntimes();
    fail(e);
  });
