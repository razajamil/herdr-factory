// The ONE herdr capability the factory reaches for over the socket instead of the CLI.
//
// §4's ownership boundary stands: herdr owns the terminal world and `HerdrClient` shells out to
// `herdr …` for every worktree/workspace/tab/pane/agent operation. This module exists because herdr's
// `layout.apply` — build a whole tab's pane tree, with labels, cwds and envs, in one atomic call — has
// no CLI surface at all. Using it is still "ask herdr to do it"; only the transport differs. Building
// the same layout through the CLI meant three subprocesses per pane, a symbolic handle map to
// re-resolve ids that only exist after each split returns, and a fixed sleep hoping a new pane's
// shell was ready — all of which the single call retires.
//
// Deliberately minimal: request/response, one call per connection, hard timeout, no subscriptions, no
// connection pool. If a second socket-only capability ever earns its place, it goes through here too.

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** herdr answered, and said no. `code` is herdr's machine reason (e.g. `invalid_params`). */
export class HerdrApiError extends Error {
  readonly code: string;
  constructor(method: string, code: string, message: string) {
    super(`herdr ${method} failed (${code}): ${message}`);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

interface Envelope {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** Default budget for one socket round-trip. Generous for a layout build (herdr spawns a shell per
 *  pane) but hard: a wedged daemon must not hold a reconcile tick, exactly as with the CLI calls. */
const DEFAULT_TIMEOUT_MS = 60_000;

let socketPathMemo: string | null = null;

/** Where the running herdr server listens.
 *
 *  herdr injects `HERDR_SOCKET_PATH` into every plugin command and every managed pane process, so in
 *  practice the first branch always wins — which matters because the layout hook runs as a plugin
 *  command in herdr's own environment. The rest mirrors herdr's own resolution order (session-aware,
 *  XDG-aware) so the factory's other entry points work when invoked from an ordinary shell. Asking
 *  `herdr status server` would answer too, but costs a subprocess for something already in the env.
 *
 *  Memoized per process — the path is fixed for a server's life, and a failed call clears the memo so
 *  a long-lived daemon re-resolves after a restart on a new path. */
export async function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (socketPathMemo) return socketPathMemo;
  const injected = env.HERDR_SOCKET_PATH?.trim();
  if (injected) return (socketPathMemo = injected);
  const configDir = env.XDG_CONFIG_HOME?.trim()
    ? join(env.XDG_CONFIG_HOME.trim(), "herdr")
    : join(env.HOME ?? homedir(), ".config", "herdr");
  const session = env.HERDR_SESSION?.trim();
  return (socketPathMemo = session ? join(configDir, "sessions", session, "herdr.sock") : join(configDir, "herdr.sock"));
}

/** One request/response round-trip against the herdr socket API.
 *
 *  Throws {@link HerdrApiError} when herdr rejects the call (a real answer the caller can act on), a
 *  plain Error for transport failures (no socket, closed early, timeout) — and clears the memoized
 *  socket path on transport failure so a restarted server is picked up on the next attempt. */
export async function herdrSocketCall<T>(
  method: string,
  params: Record<string, unknown>,
  opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<T> {
  const socketPath = opts.socketPath ?? (await resolveSocketPath());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await new Promise<T>((resolve, reject) => {
      const sock = connect(socketPath);
      let buf = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`herdr ${method} timed out after ${timeoutMs}ms`))), timeoutMs);
      timer.unref?.();

      sock.on("connect", () => sock.write(`${JSON.stringify({ id: `hf-${method}`, method, params })}\n`));
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return; // a partial frame — keep reading
        const line = buf.slice(0, nl);
        finish(() => {
          let env: Envelope;
          try {
            env = JSON.parse(line) as Envelope;
          } catch {
            reject(new Error(`herdr ${method} returned unparseable JSON: ${line.slice(0, 200)}`));
            return;
          }
          if (env.error) reject(new HerdrApiError(method, env.error.code ?? "unknown", env.error.message ?? ""));
          else resolve(env.result as T);
        });
      });
      sock.on("error", (e) => finish(() => reject(e)));
      sock.on("close", () => finish(() => reject(new Error(`herdr ${method}: socket closed before a response`))));
    });
  } catch (e) {
    if (!(e instanceof HerdrApiError)) socketPathMemo = null; // transport failure ⇒ re-resolve next time
    throw e;
  }
}
