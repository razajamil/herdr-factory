import type { StepDescriptor } from "../registry.ts";
import { BUDGET_GUARD, LAYOUT_WAIT_GUARD, READ_ONLY_GUARD } from "../guards.ts";

/** The **review** step: a fresh-eyes, strictly read-only gate. It never edits or commits — it
 *  passes the work forward or bounces back to work with findings. `evidence` is an OPTIONAL consume
 *  (a work→review→pr belt has none), so its prompt clause is dropped when no evidence was produced. */
export const reviewDescriptor: StepDescriptor = {
  name: "review",
  basePrompt: { slug: "review", perSourceOverride: true },
  defaultBudgetSeconds: 1800, // historical limits.review_budget_seconds
  consumes: [
    { type: "commits", required: true },
    { type: "handoff", required: false },
    { type: "evidence", required: false },
  ],
  produces: ["handoff"],
  controls: {
    bounce: { toEarliestConsumerOf: "bounce_feedback" }, // → work
    posture: { readOnly: true },
  },
  guards: [BUDGET_GUARD, READ_ONLY_GUARD, LAYOUT_WAIT_GUARD],
  effects: [],
};
