import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { recordDependencyDuration, telemetrySpan } from "../telemetry/index.ts";

const pexecFile = promisify(execFile);

/** Every subprocess is time-bounded: a hung `herdr`/`gh`/`git` call must never wedge the tick
 *  loop (the `ticking` flag would stay set forever and the repo would silently stop reconciling).
 *  Callers with known-slow commands (worktree create, video upload) pass a larger `timeoutMs`. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/** A subprocess exceeded its time budget and was killed. ALWAYS thrown — even under `allowFail`,
 *  which means "a non-zero exit is expected data"; a timeout is an infrastructure failure the
 *  caller must see, not an exit code to be interpreted. */
export class ExecTimeoutError extends Error {
  constructor(cmd: string, args: string[], timeoutMs: number) {
    super(`exec timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`);
    this.name = "ExecTimeoutError";
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface RunOpts {
  cwd?: string;
  allowFail?: boolean;
  maxBuffer?: number;
  /** Kill the subprocess (SIGTERM, then SIGKILL after killAfterMs) past this budget. */
  timeoutMs?: number;
}

/** Run a command (no shell — args are an array). Throws on non-zero unless allowFail; throws
 *  ExecTimeoutError on timeout regardless of allowFail. */
export async function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const attrs = {
    "dependency.name": "exec",
    "process.executable.name": cmd,
    "process.args.count": args.length,
    "exec.allow_fail": opts.allowFail === true,
  };
  return telemetrySpan("exec.run", attrs, async (span) => {
    try {
      // execFile's native timeout is used (rather than racing the promise) because it actually
      // KILLS the child — a promise-level timeout would leave the hung subprocess running.
      const { stdout, stderr } = await pexecFile(cmd, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      });
      span.setAttribute("process.exit_code", 0);
      return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
    } catch (err) {
      const e = err as {
        code?: number | string;
        killed?: boolean;
        signal?: string | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      // `killed` is set only when THIS process killed the child (timeout or maxBuffer); a null
      // code distinguishes the timeout kill from the maxBuffer kill (which carries a string code).
      if (e.killed && e.code == null) {
        span.setAttribute("exec.timed_out", true);
        throw new ExecTimeoutError(cmd, args, timeoutMs);
      }
      const code = typeof e.code === "number" ? e.code : 1;
      span.setAttribute("process.exit_code", code);
      if (opts.allowFail) {
        return {
          stdout: (e.stdout ?? "").toString(),
          stderr: (e.stderr ?? "").toString(),
          code,
        };
      }
      const detail = String(e.stderr ?? e.stdout ?? e.message ?? "").slice(0, 600);
      throw new Error(`exec failed: ${cmd} ${args.join(" ")} (code ${String(e.code)}): ${detail}`);
    } finally {
      recordDependencyDuration(Date.now() - startedAt, attrs);
    }
  });
}

/** Run a command and JSON.parse its stdout. */
export async function runJson<T>(cmd: string, args: string[], opts?: RunOpts): Promise<T> {
  const { stdout } = await run(cmd, args, opts);
  return JSON.parse(stdout) as T;
}
