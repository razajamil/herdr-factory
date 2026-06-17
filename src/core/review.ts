import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";
import { CLI_PATH, dispatchToLayout } from "./worker.ts";

/**
 * The review agent's prompt: the configured prompt_file contents plus a footer that
 * guarantees the gate is released — the agent MUST signal `review-done` when finished,
 * regardless of what the user's prompt_file says.
 */
export function reviewPrompt(deps: Deps, run: Run): string {
  const body = deps.config.review?.prompt ?? "";
  const cli = `${CLI_PATH} --repo ${deps.config.repoName} review-done ${run.ticketKey}`;
  const footer =
    `\n\n---\nWhen the review is complete, commit and push any changes to the current branch, ` +
    `then run \`${cli}\` and stop. Do NOT transition the Jira ticket.`;
  return body + footer;
}

/** Dispatch the dedicated review agent into the configured review tab/pane; returns its pane id. */
export async function spawnReview(deps: Deps, run: Run): Promise<string> {
  const review = deps.config.review;
  if (!review) throw new Error(`${run.ticketKey}: spawnReview called without review config`);
  const workspaceId = run.workspaceId;
  const worktree = run.worktreePath;
  if (!workspaceId || !worktree) throw new Error(`${run.ticketKey}: missing workspace/worktree`);

  const pane = await dispatchToLayout(deps, {
    workspaceId,
    worktree,
    tab: review.tab,
    pane: review.pane,
    prompt: reviewPrompt(deps, run),
    paneName: `review:${run.ticketKey}`,
    ticketKey: run.ticketKey,
  });
  return pane;
}
