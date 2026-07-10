import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import { serverInfoPath } from "../config.ts";
import { injectTelemetryHeaders } from "../telemetry/index.ts";
import { annotateCurrentSpan, recordHttpClientDurationEffect, telemetryEventEffect, withTelemetrySpan } from "../telemetry/effect.ts";
import { runEffectPromise } from "../runtime/effect.ts";

/** What a running `serve` advertises in server.json. */
export interface ServerInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
}

/** Thrown when the server can't be reached at all (no server.json, connection refused, timeout).
 *  This is the signal to fall back to in-process execution — distinct from an error returned by a
 *  server we DID reach (that propagates). */
export class NoServerError extends Error {}

/** Read + validate server.json. Returns null if absent or malformed (treated as "no server"). */
export function readServerInfo(): ServerInfo | null {
  try {
    const o = JSON.parse(readFileSync(serverInfoPath(), "utf8")) as Partial<ServerInfo>;
    if (typeof o.pid === "number" && typeof o.port === "number" && typeof o.version === "string") {
      return { pid: o.pid, port: o.port, version: o.version, startedAt: o.startedAt ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

/** One repo's tick health as reported by /health. */
export interface HealthRepo {
  name: string;
  active: number;
  lastTickAt: number | null;
  tickStale: boolean;
}

/** The /health payload the supervisor reads (mirrors app.ts's HealthInfo). */
export interface HealthPayload {
  ok: boolean;
  version: string;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  repos: HealthRepo[];
  /** Whether the server's https OAuth-callback listener is up (auto-capture vs paste for `auth login`). */
  oauthCallback?: boolean;
}

/**
 * Is a repo's tick loop wedged? The HTTP layer answering /health only proves the process is
 * alive — a hung subprocess inside a tick leaves the loop dead while /health stays green. The
 * repo's last COMPLETED tick going stale is the reliable signal. The threshold is generous
 * (10 ticks, floor 15min) so long-but-healthy ticks at scale never trip it, and `serverStartedAt`
 * is the baseline for a freshly (re)started server that hasn't completed its first pass yet.
 */
export function isTickStale(
  lastTickAt: number | null,
  serverStartedAt: number,
  tickIntervalSeconds: number,
  now: number,
): boolean {
  const threshold = Math.max(10 * tickIntervalSeconds, 900);
  const baseline = Math.max(lastTickAt ?? 0, serverStartedAt);
  return now - baseline > threshold;
}

/** GET /health and parse the payload; null when unreachable/non-200/malformed (treated as
 *  unhealthy by the supervisor, same as a dead process). */
export async function readHealth(port: number, timeoutMs = 3000): Promise<HealthPayload | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as HealthPayload;
    return j.ok === true ? j : null;
  } catch {
    return null;
  }
}

/** Liveness probe: GET /health, true iff it answers 200 with {ok:true} inside the timeout.
 *  A wedged-but-alive server fails this just like a dead one — which is exactly what the
 *  supervisor wants (restart on either). */
export async function pingHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const startedAt = Date.now();
  return runEffectPromise(
    withTelemetrySpan(
      "http.client.health",
      { "server.port": port, "url.path": "/health" },
      Effect.tryPromise({
        try: () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) }),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((res) =>
          Effect.gen(function* () {
            yield* annotateCurrentSpan({ "http.response.status_code": res.status });
            if (!res.ok) return false;
            const j = (yield* Effect.tryPromise({ try: () => res.json() as Promise<{ ok?: boolean }>, catch: (cause) => cause })) as { ok?: boolean };
            return j.ok === true;
          }),
        ),
        Effect.catchAll(() => annotateCurrentSpan({ "server.reachable": false }).pipe(Effect.as(false))),
        Effect.ensuring(Effect.suspend(() => recordHttpClientDurationEffect(Date.now() - startedAt, { "url.path": "/health", "server.port": port }))),
      ),
      "client",
    ),
  );
}

function serverFetchEffect(method: string, path: string, body: unknown | undefined, timeoutMs: number): Effect.Effect<unknown, unknown> {
  const startedAt = Date.now();
  return withTelemetrySpan(
    "http.client.server_fetch",
    { "http.request.method": method, "url.path": path },
    Effect.gen(function* () {
      const info = readServerInfo();
      if (!info) {
        yield* annotateCurrentSpan({ "server.advertised": false });
        return yield* Effect.fail(new NoServerError("no server.json (server not running)"));
      }
      yield* annotateCurrentSpan({ "server.port": info.port });
      const headers = injectTelemetryHeaders(body !== undefined ? { "content-type": "application/json" } : {});
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`http://127.0.0.1:${info.port}${path}`, {
            method,
            signal: AbortSignal.timeout(timeoutMs),
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((e) =>
          annotateCurrentSpan({ "server.reachable": false }).pipe(
            Effect.flatMap(() => Effect.fail(new NoServerError(e instanceof Error ? e.message : String(e)))),
          ),
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            recordHttpClientDurationEffect(Date.now() - startedAt, { "http.request.method": method, "url.path": path, "server.port": info.port }),
          ),
        ),
      );
      yield* annotateCurrentSpan({ "http.response.status_code": res.status });
      const text = yield* Effect.tryPromise({ try: () => res.text(), catch: (cause) => cause });
      const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) return yield* Effect.fail(new Error(typeof json.error === "string" ? json.error : `server returned ${res.status}`));
      return json;
    }),
    "client",
  );
}

/** Issue a request to the running server. Throws NoServerError if there's no server to reach
 *  (no server.json / connection refused / timeout); throws a normal Error if a reached server
 *  returns a non-2xx. The default timeout is generous because claim/tick can do real work. */
export async function serverFetch(method: string, path: string, body?: unknown, timeoutMs = 600_000): Promise<unknown> {
  return runEffectPromise(serverFetchEffect(method, path, body, timeoutMs));
}

/**
 * Run an operation through the server when one is up, else fall back to `local()` in-process.
 * This is the robustness contract of the whole design: the DB is the source of truth and any
 * process can act on it, so a worker's `step-done` (and every other command) keeps working even
 * while the server is restarting. Errors from a server we *reached* propagate (NOT a fallback).
 */
export async function viaServerOrLocal<T>(
  req: { method: string; path: string; body?: unknown },
  local: () => Promise<T>,
): Promise<{ viaServer: boolean; data: unknown | T }> {
  return runEffectPromise(
    withTelemetrySpan(
      "server.via_server_or_local",
      { "http.request.method": req.method, "url.path": req.path },
      serverFetchEffect(req.method, req.path, req.body, 600_000).pipe(
        Effect.flatMap((data) => annotateCurrentSpan({ "server.via_server": true }).pipe(Effect.as({ viaServer: true, data }))),
        Effect.catchAll((e) => {
          if (e instanceof NoServerError) {
            return Effect.gen(function* () {
              yield* annotateCurrentSpan({ "server.via_server": false });
              yield* telemetryEventEffect("server.fallback_local", { "url.path": req.path, reason: e.message });
              const data = yield* Effect.tryPromise({ try: local, catch: (cause) => cause });
              return { viaServer: false, data };
            });
          }
          return Effect.fail(e);
        }),
      ),
    ),
  );
}
