// Single source of truth for the running version, stamped into the server's /health and
// server.json so the supervisor (`ensure-up`) can detect an outdated `serve` and cycle it.
//
// Derived from the package version + the git HEAD short sha of THIS package — resolved against the
// package dir, never the caller's cwd (a worker invokes the CLI from other repos' worktrees, whose
// HEAD is unrelated). Any new commit (e.g. after `git pull`) changes the sha → changes VERSION →
// the next `ensure-up` tick (<=60s) sees the running `serve` is outdated and restarts it onto the
// new code, with no manual version bump or `restart`. Falls back to the bare package version when
// git/HEAD is unavailable (e.g. a tarball install with no `.git`), where restart-on-update reverts
// to a manual base-version bump.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_ROOT = new URL("..", import.meta.url);

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("package.json", PKG_ROOT), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function gitSha(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: fileURLToPath(PKG_ROOT),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return sha || null;
  } catch {
    return null;
  }
}

const sha = gitSha();
export const VERSION = sha ? `${packageVersion()}+${sha}` : packageVersion();
