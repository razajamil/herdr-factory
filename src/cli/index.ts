import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { Command } from "commander";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { lookup as mimeLookup } from "mime-types";
import { configJsonSchema, configSchemaPath, evidenceKeyPrefix, globalDbPath, isManagedNode, managedNodePath, nodePathFile, writeConfigSchema } from "../config.ts";
import { baseGroups, repoGroup, type DoctorGroup } from "../doctor.ts";
import { openDb } from "../db/index.ts";
import { Store } from "../db/store.ts";
import { systemClock, type Run } from "../types.ts";
import type { Deps } from "../core/deps.ts";
import { bounceStep, claimTicket, reconcileRepo, reconcileRun, requestHumanInput, resumeRun, teardownTicket, withTickLock, withTickLockWaiting } from "../core/reconcile.ts";
import { MEMORY_DIR, stepByName } from "../core/step.ts";
import * as service from "../watchers/service.ts";
import { buildDeps, today } from "../build-deps.ts";
import { resolveActiveRun, resolveBeltName } from "../resolve.ts";
import { serve } from "../server/serve.ts";
import { ensureUp, stopServer, type Log } from "../watchers/supervisor.ts";
import { selfUpdate } from "../watchers/updater.ts";
import { pinnedNodeVersion, provisionNode } from "../watchers/provision.ts";
import { NoServerError, pingHealth, readServerInfo, serverFetch, viaServerOrLocal } from "../server/client.ts";
import { VERSION } from "../version.ts";
import { initTelemetry, recordCliDuration, shutdownTelemetry, telemetryEnabled, telemetryEvent, telemetrySpan } from "../telemetry/index.ts";
import { disposeEffectRuntime } from "../runtime/effect.ts";

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

/** Record this node binary so `bin/herdr-factory` can re-exec with a known Node >=26 from any cwd
 *  (see config.nodePathFile). Best-effort + guarded to >=26 so we never bake an unusable path (the
 *  CLI effectively only ever runs under >=26 anyway — type-stripping + node:sqlite + the TUI's FFI
 *  require it). Runs on every invocation, so it self-heals as the pinned node is upgraded.
 *  When running under the vendored runtime (a managed install), bake the STABLE
 *  `<state>/runtime/current/bin/node` symlink path rather than this concrete version dir — so a
 *  later `.node-version` bump (which just flips that symlink) needs no re-bake. */
function bakeNodePath(): void {
  try {
    if (Number(process.versions.node.split(".")[0]) < 26) return;
    const file = nodePathFile();
    let target: string;
    if (isManagedNode(process.execPath)) {
      target = managedNodePath();
    } else {
      // Never DEMOTE a vendored-runtime path to a concrete system/nvm binary. A worker agent may run
      // the CLI under some ambient Node >=26 (the launcher prefers the active node); if a managed node
      // is already baked and still present, keep it — so `.node-version` bumps keep propagating via the
      // `current` symlink and the service's ExecStart never gets pinned to a volatile system node.
      let existing = "";
      try {
        existing = readFileSync(file, "utf8").trim();
      } catch {
        /* nothing baked yet */
      }
      if (existing && isManagedNode(existing) && existsSync(existing)) return;
      target = process.execPath;
    }
    if (existsSync(file) && readFileSync(file, "utf8") === target) return;
    mkdirSync(dirname(file), { recursive: true });
    // Atomic publish (write sibling temp, then rename) so a concurrent launcher `cat` never reads a
    // torn/empty file — writeFileSync truncates first, and multiple workers can bake at once.
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, target);
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

function bounceReasonText(opts: { reason?: string; reasonFile?: string }): string {
  if (opts.reason && opts.reasonFile) fail("bounce: pass either --reason or --reason-file, not both");
  const text = opts.reasonFile ? readFileSync(opts.reasonFile, "utf8") : opts.reason;
  if (!text?.trim()) fail("bounce: provide a non-empty --reason or --reason-file (the findings the earlier step must address)");
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

/** Print one doctor group as `✓/✗ <name> — <detail>` lines. Returns whether any check failed. */
function printDoctorGroup(g: DoctorGroup): boolean {
  let failed = false;
  console.log(`${g.title}:`);
  for (const c of g.checks) {
    if (!c.ok) failed = true;
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  return failed;
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
        const worker = r.paneId ? await deps.herdr.paneState(r.paneId).catch(() => "unknown") : "no-pane";
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
      console.log(`supervisor: ${(await service.isLoaded()) ? "loaded" : "not loaded"}`);
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
  .command("resume <key>")
  .description("un-park an `attention` run back to where it was (running/reviewing/claiming)")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(cliAction("resume", async (key: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      const { data } = await viaServerOrLocal(
        { method: "POST", path: `/repos/${encodeURIComponent(repo)}/resume`, body: { key, source: opts.source } },
        async () => {
          const deps = await buildDeps(repo);
          const run = resolveActiveRun(deps, key, opts.source);
          if (!run) {
            deps.log("warn", `${key}: no active run to resume`);
            return { ok: false, message: "no active run" };
          }
          // Resume mutates the phase and re-dispatches — serialize against the tick, like bounce.
          const { ran, result } = await withTickLockWaiting(deps, async () => {
            const res = await resumeRun(deps, deps.store.getRun(run.id)!);
            if (res.ok) await reconcileRun(deps, deps.store.getRun(run.id)!);
            return res;
          });
          if (!ran) return { ok: false, message: "dispatcher busy — retry the resume in a moment" };
          return result!;
        },
      );
      const d = data as { ok?: boolean; phase?: string; message?: string };
      if (d.ok === false) {
        console.log(`${key}: ${d.message ?? "resume failed"}`);
        return;
      }
      console.log(`${key}: resumed -> ${d.phase}`);
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
  .command("bounce <key> <toStep>")
  .description("a belt agent sends the work back to an earlier step for rework (with findings)")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .option("--reason <text>", "why it's being sent back (the findings the earlier step must address)")
  .option("--reason-file <path>", "file containing the reason/findings")
  .action(cliAction("bounce", async (key: string, toStep: string, opts: { source?: string; reason?: string; reasonFile?: string }) => {
    try {
      const repo = requireRepo();
      const reason = bounceReasonText(opts);
      const { data } = await viaServerOrLocal(
        { method: "POST", path: `/repos/${encodeURIComponent(repo)}/bounce`, body: { key, toStep, source: opts.source, reason } },
        async () => {
          const deps = await buildDeps(repo);
          const run = resolveActiveRun(deps, key, opts.source);
          if (!run) {
            deps.log("warn", `${key}: no active run to bounce`);
            return { ok: false, message: "no active run" };
          }
          const belt = deps.resolveBelt(run.belt);
          if (!belt) return { ok: false, message: `run has no configured belt "${run.belt}"` };
          const src = deps.resolveSource(run.workSource);
          if (!src) return { ok: false, message: `run has no configured work source "${run.workSource}"` };
          // The bounce rewinds the step + re-dispatches a pane, so it must run UNDER the tick lock
          // (serialized against the periodic tick), not as a fire-and-forget nudge.
          const { ran, result } = await withTickLockWaiting(deps, () => bounceStep(deps, deps.store.getRun(run.id)!, belt, src, toStep, reason));
          if (!ran) return { ok: false, message: "dispatcher busy — retry the bounce in a moment" };
          return result!;
        },
      );
      const d = data as { ok?: boolean; escalated?: boolean; message?: string };
      if (d.ok === false) {
        console.log(`${key}: ${d.message ?? "bounce failed"}`);
        return;
      }
      if (d.escalated) {
        console.log(`${key}: ${d.message}`); // bounce limit hit → parked for attention, NOT sent back
        return;
      }
      console.log(`${key}: bounced to ${toStep}${d.message ? ` — ${d.message}` : ""}`);
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
  .command("evidence-upload <key>")
  .description("publish this run's captured evidence to S3 + print the CloudFront URLs (reads the repo's `evidence:` config; uses the ambient AWS credential chain)")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .action(cliAction("evidence-upload", async (key: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      const deps = await buildDeps(repo);
      const ev = deps.config.evidence;
      if (!ev) {
        console.log("evidence-upload: no `evidence:` block configured for this repo — skipping upload (no URLs produced)");
        return;
      }
      const activeRun = resolveActiveRun(deps, key, opts.source);
      if (!activeRun?.worktreePath) {
        console.log(`${key}: no active run with a worktree — nothing to upload`);
        return;
      }
      const dir = join(activeRun.worktreePath, MEMORY_DIR, "evidence");
      // Enumerate the tree RECURSIVELY (posix-normalized relative paths) to match `aws s3 cp
      // --recursive` below — otherwise a nested asset (e.g. a video in a subdir) would be uploaded
      // with no URL, or an all-nested dir would look empty and upload nothing.
      const files = (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]) : [])
        .map((r) => r.split(sep).join("/"))
        .filter((r) => statSync(join(dir, r)).isFile())
        .sort();
      if (files.length === 0) {
        console.log("evidence-upload: no files in the evidence dir — nothing to upload");
        return;
      }
      // Key layout: herdr-factory / <github_username> / <key_prefix> / <ticketKey> / <runId>-<timestamp>.
      // The per-user folder namespaces operators in a shared bucket; username = the evidence config
      // override, else the gh-authenticated login (best-effort — omitted if gh can't resolve it). The
      // run id + timestamp mean a re-capture (e.g. after a bounce) never overwrites an earlier upload.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const githubUsername = ev.githubUsername ?? (await deps.github.currentLogin()) ?? undefined;
      if (!githubUsername) {
        console.log("evidence-upload: could not resolve github_username (set evidence.github_username or authenticate gh) — uploading under herdr-factory/ with no per-user folder");
      }
      const prefix = evidenceKeyPrefix({ githubUsername, keyPrefix: ev.keyPrefix, ticketKey: activeRun.ticketKey, runId: activeRun.id, stamp });
      // Upload via the AWS SDK (was `aws s3 cp --recursive`) — so AWS is a pnpm dep the self-updater
      // manages, not an unmanaged system binary. No `credentials` ⇒ the SDK's default provider chain
      // (env → SSO → ~/.aws → process → IMDS/role) — the SAME ambient chain the CLI read; a named
      // `profile` resolves through that chain (handles the SSO/assume-role case a bare fromIni misses).
      // No creds are stored or logged. `Upload` does multipart automatically for large evidence video.
      const s3 = new S3Client({
        region: ev.region,
        ...(ev.profile ? { credentials: fromNodeProviderChain({ profile: ev.profile }) } : {}),
      });
      for (const rel of files) {
        // ContentType is load-bearing: `aws s3 cp` guessed MIME on upload; the SDK defaults to
        // application/octet-stream, which makes CloudFront serve screenshots/video as downloads.
        await new Upload({
          client: s3,
          params: {
            Bucket: ev.bucket,
            Key: `${prefix}/${rel}`, // posix `rel` ⇒ keys match the CloudFront URLs printed below
            Body: createReadStream(join(dir, rel)),
            ContentType: mimeLookup(rel) || "application/octet-stream",
          },
        }).done();
      }
      console.log(`uploaded ${files.length} evidence file(s) to s3://${ev.bucket}/${prefix}/`);
      console.log("public URLs:");
      for (const f of files) {
        const encoded = f.split("/").map(encodeURIComponent).join("/"); // safe for spaces/specials in names
        console.log(`https://${ev.cloudfrontDomain}/${prefix}/${encoded}`);
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
  .command("provision-node")
  .description("download + verify the pinned Node (from .node-version) into <state>/runtime and point `current` at it")
  .action(cliAction("provision-node", async () => {
    try {
      const res = await provisionNode(pinnedNodeVersion(), consoleLog);
      console.log(`node ${res.version} ${res.changed ? "provisioned (current → this)" : "already current"} at ${res.nodePath}`);
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
      await service.install();
      await ensureUp({}, consoleLog);
      console.log(`installed + loaded ${service.label()} — scheduled ensure-up keeps the server serving all configured repos`);
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
      await service.uninstall();
      await stopServer(consoleLog);
      console.log(`uninstalled ${service.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("start")
  .description("load the supervisor job (and bring the server up)")
  .action(cliAction("start", async () => {
    try {
      await service.start();
      await ensureUp({}, consoleLog);
      console.log(`started ${service.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("stop")
  .description("unload the supervisor job and stop the server (workers keep running)")
  .action(cliAction("stop", async () => {
    try {
      await service.stop();
      await stopServer(consoleLog);
      console.log(`stopped ${service.label()}`);
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
  .description("health check: local + presence by default; --deep also interacts with services (gh auth, work-source health, evidence-bucket write). Add --repo <name> for repo-specific checks")
  .option("--deep", "also interact with external services: gh auth, work-source health, and an evidence-bucket write probe (network + a tiny S3 write)")
  .action(cliAction("doctor", async (opts: { deep?: boolean }) => {
    const deep = opts.deep ?? false;
    const repo = (program.opts() as { repo?: string }).repo;
    const groups = await baseGroups(deep);
    if (repo) groups.push(await repoGroup(repo, deep));
    let failed = false;
    groups.forEach((g, i) => {
      if (i > 0) console.log("");
      failed = printDoctorGroup(g) || failed;
    });
    if (!deep) console.log("\n(shallow — add `--deep` to verify gh auth, work-source health, and evidence-bucket writes)");
    else if (!repo) console.log("\n(run `herdr-factory --repo <name> doctor --deep` to add repo-specific checks)");
    if (failed) process.exitCode = 1; // so scripts/CI can gate on a clean doctor
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
