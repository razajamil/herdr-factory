import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface RunOpts {
  cwd?: string;
  allowFail?: boolean;
  maxBuffer?: number;
}

/** Run a command (no shell — args are an array). Throws on non-zero unless allowFail. */
export async function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await pexecFile(cmd, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    if (opts.allowFail) {
      return {
        stdout: (e.stdout ?? "").toString(),
        stderr: (e.stderr ?? "").toString(),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
    const detail = String(e.stderr ?? e.stdout ?? e.message ?? "").slice(0, 600);
    throw new Error(`exec failed: ${cmd} ${args.join(" ")} (code ${String(e.code)}): ${detail}`);
  }
}

/** Run a command and JSON.parse its stdout. */
export async function runJson<T>(cmd: string, args: string[], opts?: RunOpts): Promise<T> {
  const { stdout } = await run(cmd, args, opts);
  return JSON.parse(stdout) as T;
}
