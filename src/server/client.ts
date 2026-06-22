import { readFileSync } from "node:fs";
import { serverInfoPath } from "../config.ts";

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
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/** Issue a request to the running server. Throws NoServerError if there's no server to reach
 *  (no server.json / connection refused / timeout); throws a normal Error if a reached server
 *  returns a non-2xx. The default timeout is generous because claim/tick can do real work. */
export async function serverFetch(method: string, path: string, body?: unknown, timeoutMs = 600_000): Promise<unknown> {
  const info = readServerInfo();
  if (!info) throw new NoServerError("no server.json (server not running)");
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // ECONNREFUSED / timeout / DNS — the server isn't reachable. Fall back.
    throw new NoServerError(e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `server returned ${res.status}`);
  return json;
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
  try {
    const data = await serverFetch(req.method, req.path, req.body);
    return { viaServer: true, data };
  } catch (e) {
    if (e instanceof NoServerError) return { viaServer: false, data: await local() };
    throw e;
  }
}
