import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";
import { CLAUDE_FLAGS } from "./worker.ts";

/** Single-line resolver instruction (typed into the worker's TUI, so no newlines). */
export function resolverPrompt(resolveCmd: string | undefined, key: string, prNumber: number): string {
  const hint = resolveCmd ? ` following the ${resolveCmd} workflow (run ${resolveCmd} ${prNumber})` : "";
  return (
    `New review activity on PR #${prNumber} for ${key}. Address ALL unresolved review comments and fix ALL ` +
    `failing CI checks on this PR${hint}: fix each thread, commit per thread, push, resolve the thread. ` +
    `Review your changes for quality before pushing. Do NOT transition Jira. When every thread is resolved and ` +
    `CI is green, or you are blocked, stop and say so.`
  );
}

/** Reuse the tracked worker pane if alive; else spawn a fresh resolver. */
export async function wakeResolver(deps: Deps, run: Run, prNumber: number): Promise<void> {
  const prompt = resolverPrompt(deps.config.worker.resolveCmd, run.ticketKey, prNumber);

  if (run.paneId && (await deps.herdr.paneAlive(run.paneId))) {
    await deps.herdr.agentSend(run.paneId, prompt);
    await deps.herdr.paneSendKeys(run.paneId, "Enter");
    deps.log("info", `${run.ticketKey}: re-prompted worker (${run.paneId}) to resolve PR #${prNumber}`);
    return;
  }

  if (!run.workspaceId || !run.worktreePath) throw new Error(`${run.ticketKey}: cannot spawn resolver (no workspace)`);
  const pane = await deps.herdr.agentStart({
    workspaceId: run.workspaceId,
    cwd: run.worktreePath,
    argv: ["claude", ...CLAUDE_FLAGS, prompt],
  });
  if (pane) deps.store.updateRun(run.id, { paneId: pane });
  deps.log("info", `${run.ticketKey}: spawned fresh resolver for PR #${prNumber}`);
}
