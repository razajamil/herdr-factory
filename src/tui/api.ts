// Read-only client for the resident server, used by the Dashboard. Deliberately tiny: it reads the
// server's advertised port from server.json (serverInfoPath) and hits the JSON API with plain
// `fetch` — no Effect/telemetry machinery (that's the engine's server/client.ts; this is just a
// UI). Every call returns null when the server can't be reached, so the Dashboard degrades to
// "server not running" instead of throwing.
import { readFileSync } from "node:fs";
import { serverInfoPath } from "../config.ts";

interface ServerInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
}

/** Read + validate server.json; null if absent/malformed (== "no server"). */
function readInfo(): ServerInfo | null {
  try {
    const o = JSON.parse(readFileSync(serverInfoPath(), "utf8")) as Partial<ServerInfo>;
    if (typeof o.port === "number") return { pid: o.pid ?? 0, port: o.port, version: o.version ?? "?", startedAt: o.startedAt ?? 0 };
    return null;
  } catch {
    return null;
  }
}

/** One active run as returned by GET /repos/{repo}/status. */
export interface ActiveRun {
  id: number;
  ticketKey: string;
  workSource: string | null;
  belt: string | null;
  phase: string;
  step: string | null;
  prNumber: number | null;
  summary: string | null;
  outcome: string | null;
  worker: string | null;
}

export interface RepoStatus {
  repo: string;
  limits: { maxActive: number; watchHours: number };
  sources: { name: string; type: string }[];
  belts: { name: string; beltType: string; source: string; priority: number }[];
  active: ActiveRun[];
  finished: { id: number; ticketKey: string; phase: string; outcome: string | null; prNumber: number | null }[];
}

export interface Health {
  ok: boolean;
  version: string;
  pid: number;
  uptimeSec: number;
  repos: { name: string; active: number }[];
}

async function getJson<T>(path: string): Promise<T | null> {
  const info = readInfo();
  if (!info) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchHealth(): Promise<Health | null> {
  return getJson<Health>("/health");
}

export function fetchStatus(repo: string): Promise<RepoStatus | null> {
  return getJson<RepoStatus>(`/repos/${encodeURIComponent(repo)}/status`);
}

/** Best-effort hot-reload nudge after a config save, so the running server re-reads config.yml
 *  without a restart. Silent on failure (no server / older server). */
export async function postReload(): Promise<boolean> {
  const info = readInfo();
  if (!info) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/reload`, { method: "POST", signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
