import type { StepDescriptor } from "../registry.ts";
import { BUDGET_GUARD, CAPTURE_CAP_GUARD, CAPTURE_LOCK_GUARD, LAYOUT_WAIT_GUARD } from "../guards.ts";

/** The **evidence** step (opt-in): derive a test plan from the work item's acceptance criteria,
 *  drive the running app, capture + publish before/after proof, and give a per-criterion verdict —
 *  passing forward or bouncing back to work. `requiresLayout` generalizes today's opt-in rule: it
 *  materializes ONLY when the belt step ref supplies a tab/pane (else the belt is work→review→pr).
 *  Read-only (no commits) and non-heartbeat. */
export const evidenceDescriptor: StepDescriptor = {
  name: "evidence",
  basePrompt: { slug: "evidence", perSourceOverride: true },
  defaultBudgetSeconds: 2400, // historical limits.evidence_budget_seconds
  consumes: [
    { type: "work_spec", required: true },
    { type: "commits", required: true },
    { type: "handoff", required: false },
  ],
  produces: ["evidence", "handoff"],
  controls: {
    bounce: { toEarliestConsumerOf: "bounce_feedback" }, // → work
    posture: { readOnly: true, requiresLayout: true },
  },
  guards: [BUDGET_GUARD, CAPTURE_CAP_GUARD, LAYOUT_WAIT_GUARD, CAPTURE_LOCK_GUARD],
  effects: [],
};
