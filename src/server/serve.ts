// The resident `serve` daemon's lifecycle: discover repos, run a per-repo tick loop, bind the Hono
// app (server/app.ts) on @hono/node-server, advertise via server.json, and shut down gracefully.
// All HTTP routing/validation lives in app.ts; this module owns the state + process lifecycle.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { serve as nodeServe } from "@hono/node-server";
import * as Effect from "effect/Effect";
import { listConfiguredRepos, serverInfoPath, serverLogsDir, serverPort } from "../config.ts";
import { buildDeps } from "../build-deps.ts";
import { pingHealth, readServerInfo } from "./client.ts";
import { createApp, type HealthInfo, type RepoRuntime, type ServerContext } from "./app.ts";
import { reconcileRepo, withTickLock } from "../core/reconcile.ts";
import { systemClock } from "../types.ts";
import { VERSION } from "../version.ts";
import { shutdownTelemetry, withRootTelemetryContext } from "../telemetry/index.ts";
import { disposeEffectRuntime, runEffect } from "../runtime/effect.ts";
import { annotateCurrentSpan, withTelemetrySpan } from "../telemetry/effect.ts";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Server-lifecycle logging → stdout/err (captured by the supervisor's launchd log files).
 *  Per-repo work still logs to each repo's own logger inside `Deps`. */
function slog(level: "info" | "warn" | "error", m: string): void {
  process.stdout.write(`${new Date().toISOString()} [server:${level}] ${m}\n`);
}

const repos = new Map<string, RepoRuntime>();
let httpServer: ReturnType<typeof nodeServe> | undefined;
let startedAt = 0;
let shuttingDown = false;

/** (Re)build the per-repo runtimes from config. Clears any existing tick timers first. */
async function loadRepos(): Promise<void> {
  return runEffect(
    withTelemetrySpan(
      "server.load_repos",
      {},
      Effect.tryPromise({
        try: async () => {
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
        },
        catch: (cause) => cause,
      }),
    ),
  );
}

function tickRepoEffect(name: string): Effect.Effect<void, never> {
  return withTelemetrySpan(
    "server.tick_repo",
    { repo: name },
    Effect.gen(function* () {
      const rt = repos.get(name);
      if (!rt) return;
      if (rt.ticking) {
        yield* annotateCurrentSpan({ "tick.skipped": true, "tick.skip_reason": "already_ticking" });
        return;
      }
      rt.ticking = true;
      yield* Effect.tryPromise({ try: () => withTickLock(rt.deps, () => reconcileRepo(rt.deps)), catch: (cause) => cause }).pipe(
        Effect.flatMap((ran) =>
          Effect.all([
            annotateCurrentSpan({ "tick.ran": ran }),
            Effect.sync(() => {
              if (!ran) rt.deps.log("info", "another tick already running — skipping");
            }),
          ], { discard: true }),
        ),
        Effect.catchAll((e) => Effect.sync(() => rt.deps.log("error", `tick failed — ${msg(e)}`))),
        Effect.ensuring(Effect.sync(() => {
          rt.ticking = false;
        })),
      );
    }),
  ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

/** One guarded reconcile pass for a repo: the in-flight flag stops a slow tick from stacking, and
 *  withTickLock is the cross-process backstop (a stray CLI `tick` can't overlap either). */
async function tickRepo(name: string): Promise<void> {
  return runEffect(tickRepoEffect(name));
}

/** Start each repo's tick loop at its own tick_interval, with an immediate first pass (RunAtLoad
 *  equivalent). */
function startLoops(): void {
  for (const [name, rt] of repos) {
    void withRootTelemetryContext(() => tickRepo(name));
    rt.timer = setInterval(() => void withRootTelemetryContext(() => tickRepo(name)), rt.deps.config.limits.tickIntervalSeconds * 1000);
  }
}

function health(): HealthInfo {
  return {
    ok: true,
    version: VERSION,
    pid: process.pid,
    startedAt,
    uptimeSec: systemClock() - startedAt,
    repos: [...repos.entries()].map(([name, rt]) => ({ name, active: rt.deps.store.countActive(name) })),
  };
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
  await Promise.all([shutdownTelemetry(), disposeEffectRuntime()]);
  process.exit(0);
}

/** Entry point for the `serve` command: bind (Hono on @hono/node-server), advertise (server.json),
 *  run the per-repo loops. */
export async function serve(): Promise<void> {
  return runEffect(withTelemetrySpan("server.serve", {}, Effect.tryPromise({ try: serveImpl, catch: (cause) => cause })));
}

async function serveImpl(): Promise<void> {
  // Single-instance guard #1: if a healthy server is already advertised, defer to it.
  const existing = readServerInfo();
  if (existing && (await pingHealth(existing.port))) {
    slog("info", `another server already healthy on :${existing.port} — exiting`);
    return;
  }

  await loadRepos();
  const port = serverPort();

  const ctx: ServerContext = {
    health,
    reload: async () => {
      await loadRepos();
      startLoops();
      return [...repos.keys()];
    },
    // Defer briefly so the HTTP /shutdown response flushes before the drain + process.exit
    // (with no in-flight ticks the drain returns instantly, which would race the response).
    requestShutdown: (why) => {
      setTimeout(() => void shutdown(why), 250);
    },
    getRepo: (name) => repos.get(name),
    knownRepos: () => [...repos.keys()],
  };
  const app = createApp(ctx);

  // Single-instance guard #2 (authoritative): the bind itself. A second serve loses with
  // EADDRINUSE (the server emits 'error') and exits — no two servers can own the port.
  try {
    await new Promise<void>((resolve, reject) => {
      const srv = nodeServe({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve());
      srv.once("error", reject);
      httpServer = srv;
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
  // The bound server + interval timers keep the event loop alive; this returns and the process
  // stays resident until a signal / POST /shutdown.
}
