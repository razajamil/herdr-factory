import type { StepDescriptor } from "../registry.ts";
import { BUDGET_GUARD, HEARTBEAT_GUARD, LAYOUT_WAIT_GUARD } from "../guards.ts";

/** The **work** step (formerly "fix"): read the work item + attachments, implement the change, run
 *  the repo's lint/type/tests, and commit incrementally. Produces `commits`; may be sent back for
 *  rework (it is the earliest `bounce_feedback` consumer, so evidence/review bounce here). */
export const workDescriptor: StepDescriptor = {
  name: "work",
  basePrompt: { slug: "work", perSourceOverride: true }, // prompts/work.md + prompts/<type>/work.md
  defaultBudgetSeconds: 5400, // historical limits.develop_budget_seconds
  consumes: [
    { type: "work_spec", required: true },
    { type: "work_raw", required: false },
    { type: "bounce_feedback", required: false }, // the RECEIVE side of the bounce pair
  ],
  produces: ["commits", "handoff"],
  controls: { posture: {} },
  guards: [BUDGET_GUARD, HEARTBEAT_GUARD, LAYOUT_WAIT_GUARD],
  effects: [], // belt_start→in_development is an engine default; no per-step effect needed
};
