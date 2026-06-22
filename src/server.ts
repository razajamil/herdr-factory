import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { listConfiguredRepos, serverInfoPath, serverLogsDir, serverPort } from "./config.ts";
import { buildDeps } from "./build-deps.ts";
import { pingHealth, readServerInfo } from "./server-client.ts";
import { resolveActiveRun, resolveSourceName } from "./resolve.ts";
import { claimTicket, reconcileRepo, reconcileRun, teardownTicket, withTickLock } from "./core/reconcile.ts";
import { systemClock, type StepName } from "./types.ts";
import { VERSION } from "./version.ts";
import type { Deps } from "./core/deps.ts";

const STEPS: StepName[] = ["fix", "review", "pr"];

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Server-lifecycle logging → stdout/err (captured by the supervisor's launchd log files).
 *  Per-repo work still logs to each repo's own logger inside `Deps`. */
function slog(level: "info" | "warn" | "error", m: string): void {
  process.stdout.write(`${new Date().toISOString()} [server:${level}] ${m}\n`);
}

interface RepoRuntime {
  deps: Deps;
  timer?: NodeJS.Timeout;
  ticking: boolean;
}

const repos = new Map<string, RepoRuntime>();
let httpServer: Server | undefined;
let startedAt = 0;
let shuttingDown = false;

/** (Re)build the per-repo runtimes from config. Clears any existing tick timers first. */
async function loadRepos(): Promise<void> {
  for (const rt of repos.values()) if (rt.timer) clearInterval(rt.timer);
  repos.clear();
  for (const name of listConfiguredRepos()) {
    try {
      const deps = await buildDeps(name);
      repos.set(name, { deps, ticking: false });
    } catch (e) {
      slog("error", `repo "${name}": failed to load — ${msg(e)}`);
    }
  }
}

/** One guarded reconcile pass for a repo: the in-flight flag stops a slow tick from stacking, and
 *  withTickLock is the cross-process backstop (a stray CLI `tick` can't overlap either). */
async function tickRepo(name: string): Promise<void> {
  const rt = repos.get(name);
  if (!rt || rt.ticking) return;
  rt.ticking = true;
  try {
    const ran = await withTickLock(rt.deps, () => reconcileRepo(rt.deps));
    if (!ran) rt.deps.log("info", "another tick already running — skipping");
  } catch (e) {
    rt.deps.log("error", `tick failed — ${msg(e)}`);
  } finally {
    rt.ticking = false;
  }
}

/** Start each repo's tick loop at its own tick_interval, with an immediate first pass (RunAtLoad
 *  equivalent). */
function startLoops(): void {
  for (const [name, rt] of repos) {
    void tickRepo(name);
    rt.timer = setInterval(() => void tickRepo(name), rt.deps.config.limits.tickIntervalSeconds * 1000);
  }
}

function health(): Record<string, unknown> {
  return {
    ok: true,
    version: VERSION,
    pid: process.pid,
    startedAt,
    uptimeSec: systemClock() - startedAt,
    repos: [...repos.entries()].map(([name, rt]) => ({ name, active: rt.deps.store.countActive(name) })),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build the structured status payload — the same data the CLI `status` renders, exposed here for
 *  the future web UI. Hits herdr for live pane state, so it's async. */
async function statusPayload(rt: RepoRuntime): Promise<Record<string, unknown>> {
  const c = rt.deps.config;
  const active = rt.deps.store.activeRuns(c.repoName);
  const recent = rt.deps.store.listRuns(c.repoName, true);
  const finished = recent.filter((r) => r.endedAt !== null);
  const runView = async (r: (typeof active)[number]) => ({
    id: r.id,
    ticketKey: r.ticketKey,
    workSource: r.workSource,
    phase: r.phase,
    prNumber: r.prNumber,
    summary: r.summary,
    outcome: r.outcome,
    worker: r.paneId ? await rt.deps.herdr.paneState(r.paneId) : null,
    steps: rt.deps.store.runStepsFor(r.id).map((s) => ({ step: s.step, done: s.done })),
  });
  return {
    repo: c.repoName,
    limits: { maxActive: c.limits.maxActive, watchHours: c.limits.watchHours },
    sources: c.sources.map((s) => ({ name: s.name, type: s.type, priority: s.priority })),
    active: await Promise.all(active.map(runView)),
    finished: finished.map((r) => ({ id: r.id, ticketKey: r.ticketKey, phase: r.phase, outcome: r.outcome, prNumber: r.prNumber })),
  };
}

async function eligiblePayload(rt: RepoRuntime): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const src of rt.deps.sources) {
    try {
      for (const t of await src.client.listEligible()) out.push({ source: src.name, ...t });
    } catch (e) {
      rt.deps.log("warn", `${src.name}: eligible query failed: ${msg(e)}`);
    }
  }
  return out;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && url.pathname === "/health") return send(res, 200, health());
    if (method === "POST" && url.pathname === "/reload") {
      await loadRepos();
      startLoops();
      return send(res, 200, { ok: true, repos: [...repos.keys()] });
    }
    if (method === "POST" && url.pathname === "/shutdown") {
      send(res, 200, { ok: true });
      void shutdown("http /shutdown");
      return;
    }

    if (parts[0] === "repos" && parts[1]) {
      const name = decodeURIComponent(parts[1]);
      const rt = repos.get(name);
      if (!rt) return send(res, 404, { error: `repo "${name}" not configured (server knows: ${[...repos.keys()].join(", ") || "none"})` });
      const action = parts[2];
      const body = method === "POST" ? await readBody(req) : {};

      if (method === "POST" && action === "tick") {
        const ran = await withTickLock(rt.deps, () => reconcileRepo(rt.deps));
        return send(res, 200, { ran });
      }
      if (method === "POST" && action === "step-done") {
        const key = str(body.key);
        const step = str(body.step);
        if (!key || !step || !STEPS.includes(step as StepName)) {
          return send(res, 400, { error: "step-done needs {key, step: fix|review|pr}" });
        }
        const run = resolveActiveRun(rt.deps, key, str(body.source));
        if (!run) return send(res, 200, { ok: false, message: `${key}: no active run` });
        rt.deps.store.markStepDone(run.id, step as StepName);
        rt.deps.store.recordEvent({ runId: run.id, repo: name, ticketKey: key, type: "step_done", detail: { step } });
        rt.deps.log("info", `${key}: step-done ${step} recorded`);
        const advanced = await withTickLock(rt.deps, () => reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!));
        return send(res, 200, { ok: true, advanced });
      }
      if (method === "POST" && action === "claim") {
        const key = str(body.key);
        if (!key) return send(res, 400, { error: "claim needs {key}" });
        await claimTicket(rt.deps, resolveSourceName(rt.deps, str(body.source)), key);
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && action === "teardown") {
        const key = str(body.key);
        if (!key) return send(res, 400, { error: "teardown needs {key}" });
        await teardownTicket(rt.deps, key, str(body.source));
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && action === "status") return send(res, 200, await statusPayload(rt));
      if (method === "GET" && action === "runs") {
        const all = url.searchParams.get("all") != null;
        return send(res, 200, { runs: rt.deps.store.listRuns(name, all) });
      }
      if (method === "GET" && action === "eligible") return send(res, 200, { eligible: await eligiblePayload(rt) });
      if (method === "GET" && action === "timeline") {
        const key = url.searchParams.get("key");
        if (!key) return send(res, 400, { error: "timeline needs ?key=" });
        return send(res, 200, { timeline: rt.deps.store.timeline(name, key) });
      }
    }

    return send(res, 404, { error: `no route for ${method} ${url.pathname}` });
  } catch (e) {
    return send(res, 500, { error: msg(e) });
  }
}

async function shutdown(why: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  slog("info", `shutting down (${why})`);
  for (const rt of repos.values()) if (rt.timer) clearInterval(rt.timer);
  httpServer?.close();
  // Let any in-flight tick finish (state is idempotent + on disk, so a hard kill is safe too;
  // this just avoids a torn mid-pass log).
  const deadline = Date.now() + 15_000;
  while ([...repos.values()].some((r) => r.ticking) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    rmSync(serverInfoPath());
  } catch {
    /* already gone */
  }
  process.exit(0);
}

/** Entry point for the `serve` command: bind, advertise (server.json), run the per-repo loops. */
export async function serve(): Promise<void> {
  // Single-instance guard #1: if a healthy server is already advertised, defer to it.
  const existing = readServerInfo();
  if (existing && (await pingHealth(existing.port))) {
    slog("info", `another server already healthy on :${existing.port} — exiting`);
    return;
  }

  await loadRepos();
  const port = serverPort();
  httpServer = createServer((req, res) => void handle(req, res));

  // Single-instance guard #2 (authoritative): the bind itself. A second serve loses with
  // EADDRINUSE and exits — no two servers can own the port.
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject);
      httpServer!.listen(port, "127.0.0.1", () => {
        httpServer!.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    slog("error", `failed to bind 127.0.0.1:${port} — ${msg(e)}`);
    process.exit(1);
  }

  startedAt = systemClock();
  mkdirSync(serverLogsDir(), { recursive: true });
  writeFileSync(serverInfoPath(), JSON.stringify({ pid: process.pid, port, version: VERSION, startedAt }));
  slog("info", `serving on 127.0.0.1:${port} — repos: ${[...repos.keys()].join(", ") || "(none)"}`);

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  startLoops();
  // The HTTP server + interval timers keep the event loop alive; this function returns and the
  // process stays resident until a signal / POST /shutdown.
}
