import type { StepDescriptor } from "../registry.ts";
import { BUDGET_GUARD, LAYOUT_WAIT_GUARD } from "../guards.ts";

/** The generic **custom** step: a user-defined station whose `prompt_file` (required) is the WHOLE
 *  body — the engine adds only the handover scaffold. This is the primitive that composes the
 *  research → propose → create_jira_ticket style belts. No engine base prompt, no fixed products
 *  beyond the mandatory `handoff`. A step ref may opt into a commit-stall `heartbeat` (which also
 *  makes it a `commits` producer) and, of course, a layout tab/pane. Budget falls back to
 *  `limits.step_budget_seconds`. */
export const customDescriptor: StepDescriptor = {
  name: "custom",
  promptFileRequired: true, // no basePrompt — the user prompt is the whole body
  consumes: [
    { type: "work_spec", required: false },
    { type: "handoff", required: false },
    { type: "bounce_feedback", required: false },
  ],
  produces: ["handoff"],
  controls: { posture: {} },
  guards: [BUDGET_GUARD, LAYOUT_WAIT_GUARD], // heartbeat is opt-in per step ref
  effects: [],
};
