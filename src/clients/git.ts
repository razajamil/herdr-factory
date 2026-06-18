import { run } from "./exec.ts";

/** Git operations herdr-factory performs directly (outside herdr's model). */
export class GitClient {
  async branchExists(repoCwd: string, branch: string): Promise<boolean> {
    const r = await run("git", ["-C", repoCwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      allowFail: true,
    });
    return r.code === 0;
  }

  async branchDelete(repoCwd: string, branch: string): Promise<void> {
    await run("git", ["-C", repoCwd, "branch", "-D", branch], { allowFail: true });
  }

  async worktreePrune(repoCwd: string): Promise<void> {
    await run("git", ["-C", repoCwd, "worktree", "prune"], { allowFail: true });
  }

  async originUrl(repoCwd: string): Promise<string> {
    const r = await run("git", ["-C", repoCwd, "remote", "get-url", "origin"], { allowFail: true });
    return r.stdout.trim();
  }

  /** Current HEAD commit of a worktree, or null if git can't resolve it. Used as the
   *  worker's progress heartbeat — a moving HEAD means real work happened. */
  async headSha(repoCwd: string): Promise<string | null> {
    const r = await run("git", ["-C", repoCwd, "rev-parse", "HEAD"], { allowFail: true });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : null;
  }
}

/** owner/name from a git origin URL (ssh or https), or null. */
export function parseGhRepo(originUrl: string): string | null {
  const m = originUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : null;
}
