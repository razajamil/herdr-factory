// GitClient.branchDelete robustness — the teardown branch-leak fix. Uses a REAL temp git repo so it
// exercises actual `git branch -D` / `git worktree` semantics, not a fake.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitClient } from "../src/clients/git.ts";
import { run } from "../src/clients/exec.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

async function tempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "git-test-"));
  tmps.push(dir);
  await run("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", dir, "config", "user.name", "Test"]);
  await run("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("GitClient.branchDelete", () => {
  const git = new GitClient();

  it("deletes a plain (not-checked-out) branch and reports success", async () => {
    const dir = await tempRepo();
    await run("git", ["-C", dir, "branch", "fix/plain"]);
    expect(await git.branchExists(dir, "fix/plain")).toBe(true);
    expect(await git.branchDelete(dir, "fix/plain")).toBe(true);
    expect(await git.branchExists(dir, "fix/plain")).toBe(false);
  });

  it("is idempotent — reports success when the branch never existed", async () => {
    const dir = await tempRepo();
    expect(await git.branchDelete(dir, "fix/never")).toBe(true);
  });

  it("force-removes a lingering worktree still on the branch, then deletes it (the abandoned-run leak)", async () => {
    const dir = await tempRepo();
    const wt = join(tmpdir(), `git-wt-${Math.random().toString(36).slice(2)}`);
    tmps.push(wt);
    // A worktree checked out on the branch — exactly what a partial teardown of an abandoned run
    // leaves behind. Plain `git branch -D` REFUSES this ("checked out at …").
    await run("git", ["-C", dir, "worktree", "add", "-q", wt, "-b", "fix/abandoned"]);
    expect(await git.branchExists(dir, "fix/abandoned")).toBe(true);
    // Sanity: the plain delete really does fail while the worktree is registered.
    await run("git", ["-C", dir, "branch", "-D", "fix/abandoned"], { allowFail: true });
    expect(await git.branchExists(dir, "fix/abandoned")).toBe(true);
    // The robust path: force-remove the worktree + retry.
    expect(await git.branchDelete(dir, "fix/abandoned")).toBe(true);
    expect(await git.branchExists(dir, "fix/abandoned")).toBe(false);
    expect(existsSync(wt)).toBe(false); // the lingering worktree dir is gone too
  });
});
