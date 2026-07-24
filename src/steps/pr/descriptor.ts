import type { StepDescriptor } from "../registry.ts";
import { BUDGET_GUARD, HEARTBEAT_GUARD, LAYOUT_WAIT_GUARD } from "../guards.ts";

/** The **pr** step: push the branch, open the PR (embedding evidence URLs + any close_reference),
 *  and drive the automated round (CI green, bot comments). It PRODUCES `pull_request` — which
 *  attaches PR adoption identity, the produce→in_review effect, and the terminal review-watch (with
 *  its resolver) via the pull_request ProductCapability. Commits again during the CI round, so it
 *  keeps a heartbeat. */
export const prDescriptor: StepDescriptor = {
  name: "pr",
  basePrompt: { slug: "pr", perSourceOverride: true }, // prompts/pr.md + prompts/<type>/pr.md
  defaultBudgetSeconds: 3600, // historical limits.pr_budget_seconds
  consumes: [
    { type: "commits", required: true },
    { type: "handoff", required: false },
    { type: "evidence", required: false },
    { type: "close_reference", required: false },
  ],
  produces: ["pull_request", "commits", "handoff"], // re-commits during the CI/bot round (heartbeat)
  controls: {},
  guards: [HEARTBEAT_GUARD, BUDGET_GUARD, LAYOUT_WAIT_GUARD], // heartbeat first: on a double-trip the stall diagnosis wins (see guards.ts)
  effects: [], // produce→in_review lives on the pull_request ProductCapability
};
