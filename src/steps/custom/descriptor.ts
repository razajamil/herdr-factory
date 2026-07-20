import type { StepDescriptor } from "../registry.ts";
import { BUDGET_GUARD, LAYOUT_WAIT_GUARD } from "../guards.ts";

/** The generic **custom** step: a user-defined station whose `prompt_file` (required) is the WHOLE
 *  body — the engine adds only the handover scaffold. This is the primitive that composes the
 *  research → propose → create_jira_ticket style belts. No engine base prompt, no fixed products
 *  beyond the mandatory `handoff`.
 *
 *  `refCapabilities: true` lets a step ref EXTEND these base declarations from the config-declared
 *  allow-list (`src/config.ts`), so you build your own gates without forking the registry:
 *   - `consumes: [commits]` — place the step after a code-writing step and receive its context.
 *   - `produces: [commits]` — a code-writing custom station (like the `heartbeat` opt-in, which also
 *     makes it a `commits` producer for the commit-stall watchdog).
 *   - `read_only: true`   — a gate that never commits (enforced exactly like review/evidence: HEAD
 *     movement parks the run); mutually exclusive with producing `commits`.
 *   - `bounce: true`      — may send the work back to the earliest earlier `bounce_feedback` consumer
 *     (this descriptor is itself one), counting toward `max_bounces`.
 *  Producing `pull_request`/`evidence` stays out of scope — those drag heavy engine machinery and
 *  remain descriptor/plugin territory. All opt-ins are validated by the load-time dataflow rules
 *  (a required consume needs an upstream producer; a bounce emitter needs an upstream consumer).
 *
 *  Budget falls back to `limits.step_budget_seconds`. */
export const customDescriptor: StepDescriptor = {
  name: "custom",
  promptFileRequired: true, // no basePrompt — the user prompt is the whole body
  refCapabilities: true, // a step ref may declare its own gates (consumes/produces/read_only/bounce)
  consumes: [
    { type: "work_spec", required: false },
    { type: "handoff", required: false },
    { type: "bounce_feedback", required: false }, // the RECEIVE side of the bounce pair (always a valid target)
  ],
  produces: ["handoff"],
  controls: { posture: {} },
  guards: [BUDGET_GUARD, LAYOUT_WAIT_GUARD], // heartbeat is opt-in per step ref
  effects: [],
};
