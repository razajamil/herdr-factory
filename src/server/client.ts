import { readFileSync } from "node:fs";
import { serverInfoPath } from "../config.ts";
import { injectTelemetryHeaders, recordHttpClientDuration, telemetryEvent, telemetrySpan } from "../telemetry/index.ts";

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

/** Liveness probe: GET /health, true iff it answers 200 with {ok:true} inside the timeout.
 *  A wedged-but-alive server fails this just like a dead one — which is exactly what the
 *  supervisor wants (restart on either). */
export async function pingHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const startedAt = Date.now();
  return telemetrySpan("http.client.health", { "server.port": port, "url.path": "/health" }, async (span) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      span.setAttribute("http.response.status_code", res.status);
      if (!res.ok) return false;
      const j = (await res.json()) as { ok?: boolean };
      return j.ok === true;
    } catch {
      span.setAttribute("server.reachable", false);
      return false;
    } finally {
      recordHttpClientDuration(Date.now() - startedAt, { "url.path": "/health", "server.port": port });
    }
  });
}

/** Issue a request to the running server. Throws NoServerError if there's no server to reach
 *  (no server.json / connection refused / timeout); throws a normal Error if a reached server
 *  returns a non-2xx. The default timeout is generous because claim/tick can do real work. */
export async function serverFetch(method: string, path: string, body?: unknown, timeoutMs = 600_000): Promise<unknown> {
  const startedAt = Date.now();
  return telemetrySpan("http.client.server_fetch", { "http.request.method": method, "url.path": path }, async (span) => {
    const info = readServerInfo();
    if (!info) {
      span.setAttribute("server.advertised", false);
      throw new NoServerError("no server.json (server not running)");
    }
    span.setAttribute("server.port", info.port);
    let res: Response;
    try {
      const headers = injectTelemetryHeaders(body !== undefined ? { "content-type": "application/json" } : {});
      res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // ECONNREFUSED / timeout / DNS — the server isn't reachable. Fall back.
      span.setAttribute("server.reachable", false);
      throw new NoServerError(e instanceof Error ? e.message : String(e));
    } finally {
      recordHttpClientDuration(Date.now() - startedAt, { "http.request.method": method, "url.path": path, "server.port": info.port });
    }
    span.setAttribute("http.response.status_code", res.status);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `server returned ${res.status}`);
    return json;
  });
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
  return telemetrySpan("server.via_server_or_local", { "http.request.method": req.method, "url.path": req.path }, async (span) => {
    try {
      const data = await serverFetch(req.method, req.path, req.body);
      span.setAttribute("server.via_server", true);
      return { viaServer: true, data };
    } catch (e) {
      if (e instanceof NoServerError) {
        span.setAttribute("server.via_server", false);
        telemetryEvent("server.fallback_local", { "url.path": req.path, reason: e.message });
        return { viaServer: false, data: await local() };
      }
      throw e;
    }
  });
}
