import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";
import { CLAUDE_FLAGS } from "./step.ts";

/** Single-line resolver instruction (typed into the pr agent's TUI, so no newlines). */
export function resolverPrompt(key: string, prNumber: number): string {
  return (
    `New review activity on PR #${prNumber} for ${key}. Address ALL unresolved review comments and fix ALL ` +
    `failing CI checks on this PR: fix each thread, commit per thread, push, resolve the thread. ` +
    `Review your changes for quality before pushing. Do NOT transition Jira. When every thread is resolved and ` +
    `CI is green, or you are blocked, stop and say so.`
  );
}

/** Reuse the run's latest agent pane (the pr step) if alive; else spawn a fresh resolver.
 *  Returns true if a resolver was actually dispatched, false if the spawn failed (so the
 *  caller can retry rather than mark the review round handled). */
export async function wakeResolver(deps: Deps, run: Run, prNumber: number): Promise<boolean> {
  const prompt = resolverPrompt(run.ticketKey, prNumber);

  if (run.paneId && (await deps.herdr.paneAlive(run.paneId))) {
    await deps.herdr.agentSend(run.paneId, prompt);
    await deps.herdr.paneSendKeys(run.paneId, "Enter");
    deps.log("info", `${run.ticketKey}: re-prompted agent (${run.paneId}) to resolve PR #${prNumber}`);
    return true;
  }

  if (!run.workspaceId || !run.worktreePath) throw new Error(`${run.ticketKey}: cannot spawn resolver (no workspace)`);
  const pane = await deps.herdr.agentStart({
    workspaceId: run.workspaceId,
    cwd: run.worktreePath,
    argv: ["claude", ...CLAUDE_FLAGS, prompt],
  });
  if (!pane) {
    deps.log("warn", `${run.ticketKey}: resolver agentStart returned no pane for PR #${prNumber}`);
    return false;
  }
  deps.store.updateRun(run.id, { paneId: pane });
  deps.log("info", `${run.ticketKey}: spawned fresh resolver for PR #${prNumber}`);
  return true;
}
