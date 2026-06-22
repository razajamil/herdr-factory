// Supervised self-updater: pull THIS package's latest code and hard-reset the working tree to its
// upstream, so a `git pull`-equivalent happens unattended. Resolved against the package dir (never
// the caller's cwd — a worker invokes the CLI from other repos' worktrees). Best-effort: any
// problem returns {updated:false, reason} instead of throwing, so it can never break a supervisor
// tick. Strategy is a HARD RESET to @{u}: the box always ends up exactly matching the remote (local
// edits on the daemon machine are discarded, by design). When it updates, the caller restarts the
// server — VERSION is derived from the git sha, so the freshly spawned process advertises the new
// version (and migrations re-run on the new DB connection).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Log } from "./supervisor.ts";

const execFileP = promisify(execFile);
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Auto-update is ON by default; set HERDR_FACTORY_AUTO_UPDATE to 0/false/no/off to disable it. */
export function autoUpdateEnabled(): boolean {
  const v = (process.env.HERDR_FACTORY_AUTO_UPDATE ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

export interface UpdateResult {
  updated: boolean;
  reason?: string; // why it didn't update (when updated === false)
  from?: string;
  to?: string;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd: PKG_ROOT });
  return stdout.trim();
}

/** Did package.json / pnpm-lock.yaml change between two commits? */
async function depsChanged(from: string, to: string): Promise<boolean> {
  try {
    const changed = await git(["diff", "--name-only", from, to]);
    return changed.split("\n").some((f) => f === "package.json" || f === "pnpm-lock.yaml");
  } catch {
    return false;
  }
}

async function have(cmd: string): Promise<boolean> {
  try {
    await execFileP(cmd, ["--version"], { cwd: PKG_ROOT });
    return true;
  } catch {
    return false;
  }
}

/** (Re)install dependencies after a code update. No native modules → no rebuild needed. Best-effort:
 *  a failed install is logged but doesn't abort the update (the restart still picks up the code). */
async function installDeps(log: Log): Promise<void> {
  try {
    if (await have("pnpm")) {
      log("info", "self-update: dependencies changed — pnpm install");
      await execFileP("pnpm", ["install"], { cwd: PKG_ROOT });
    } else {
      log("info", "self-update: dependencies changed — npm install");
      await execFileP("npm", ["install", "--no-audit", "--no-fund"], { cwd: PKG_ROOT });
    }
  } catch (e) {
    log("warn", `self-update: dependency install failed — ${msg(e)} (continuing)`);
  }
}

/** Fetch + hard-reset this package to its upstream. Returns whether the working tree changed. */
export async function selfUpdate(log: Log): Promise<UpdateResult> {
  if (!existsSync(join(PKG_ROOT, ".git"))) return { updated: false, reason: "not a git checkout" };

  let before: string;
  let upstream: string;
  try {
    before = await git(["rev-parse", "HEAD"]);
    upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); // e.g. origin/main
  } catch {
    return { updated: false, reason: "no upstream configured" };
  }

  try {
    await git(["fetch", "--quiet"]);
  } catch (e) {
    log("warn", `self-update: git fetch failed — ${msg(e)}`);
    return { updated: false, reason: "fetch failed" };
  }

  let after: string;
  try {
    after = await git(["rev-parse", upstream]);
  } catch {
    return { updated: false, reason: "cannot resolve upstream" };
  }
  if (after === before) return { updated: false, reason: "up to date" };

  try {
    await git(["reset", "--hard", upstream]);
  } catch (e) {
    log("warn", `self-update: git reset failed — ${msg(e)}`);
    return { updated: false, reason: "reset failed" };
  }
  log("info", `self-update: ${before.slice(0, 12)} → ${after.slice(0, 12)} (hard reset to ${upstream})`);

  if (await depsChanged(before, after)) await installDeps(log);

  return { updated: true, from: before, to: after };
}
