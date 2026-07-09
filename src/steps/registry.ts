// The step-primitive REGISTRY: one descriptor per step type, and the single edit surface for
// adding a new one. Mirrors src/sources/registry.ts (SourceDescriptor). The reconciler branches on
// a descriptor's DECLARATIONS (consumes/produces/controls/guards/effects/posture), never on a step
// name — so w2pr's fix/evidence/review/pr and any user/plugin step are the same machinery.
//
// ── Adding step primitive N+1 (the whole checklist) ──────────────────────────────────────────────
//  1. src/steps/<name>/descriptor.ts     — the StepDescriptor (+ its base prompt in src/prompts/)
//  2. one entry in STEP_DESCRIPTORS       — below
//  3. any new ProductCapability / SignalDescriptor it introduces (src/products, src/signals)
//  4. `npm run schema`                    — regenerate config.schema.json (test-enforced)
//  5. a harness in the step-descriptor contract suite (test/step-descriptor-contract.test.ts)
// Zero other core edits — anything more means the abstraction leaked; fix the leak instead.
import type { EffectSpec, GuardSpec, InputSpec, ProductType, StepPosture } from "../types.ts";
// Re-export the guard builders (defined in the leaf ./guards.ts to avoid a load-time cycle:
// registry imports descriptors, and descriptors need the guards at import-eval time).
export { BUDGET_GUARD, HEARTBEAT_GUARD, LAYOUT_WAIT_GUARD, CAPTURE_CAP_GUARD } from "./guards.ts";
import { workDescriptor } from "./work/descriptor.ts";
import { evidenceDescriptor } from "./evidence/descriptor.ts";
import { reviewDescriptor } from "./review/descriptor.ts";
import { prDescriptor } from "./pr/descriptor.ts";
import { customDescriptor } from "./custom/descriptor.ts";

/** A named base-prompt library entry. `perSourceOverride` allows a prompts/<sourceType>/<slug>.md
 *  specialization over the shared prompts/<slug>.md. */
export interface PromptRef {
  readonly slug: string;
  readonly perSourceOverride: boolean;
}

/** The agent-facing terminal signals + posture a step supports. step_done + ask_human are ALWAYS
 *  available (never declared). `bounce` is the EMIT side of the producer/consumer bounce pair — its
 *  target is resolved at belt-composition time to the nearest earlier step that consumes
 *  bounce_feedback. */
export interface StepControls {
  readonly bounce?: { readonly toEarliestConsumerOf: "bounce_feedback" };
  readonly posture?: StepPosture;
}

/** One step primitive: a base prompt + a declarative capability spec. `produces` MUST include
 *  "handoff" (mandatory on every step; enforced by the contract suite).
 *  - `basePrompt` ABSENT ⇒ the generic step whose user `prompt_file` is the WHOLE body (custom);
 *    `promptFileRequired` is then true. PRESENT ⇒ an engine base the optional `prompt_file` augments.
 *  - `defaultBudgetSeconds` ABSENT ⇒ the belt step ref's `budget_seconds` else `limits.step_budget_seconds`. */
export interface StepDescriptor {
  readonly name: string;
  readonly basePrompt?: PromptRef;
  readonly promptFileRequired?: boolean;
  readonly defaultBudgetSeconds?: number;
  readonly consumes: readonly InputSpec[];
  readonly produces: readonly ProductType[];
  readonly controls: StepControls;
  readonly guards: readonly GuardSpec[];
  readonly effects: readonly EffectSpec[];
}

export const STEP_DESCRIPTORS: readonly StepDescriptor[] = [
  workDescriptor,
  evidenceDescriptor,
  reviewDescriptor,
  prDescriptor,
  customDescriptor,
];

/** The registered step primitive for `name`, or undefined (an unknown `type:` in a belt step ref —
 *  the config loader reports it against the closed step-type enum). */
export function stepDescriptorFor(name: string): StepDescriptor | undefined {
  return STEP_DESCRIPTORS.find((d) => d.name === name);
}
