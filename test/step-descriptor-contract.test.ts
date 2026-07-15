import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STEP_DESCRIPTORS } from "../src/steps/registry.ts";
import { PRODUCT_CAPABILITIES, productCapabilityFor } from "../src/products/registry.ts";
import { SIGNAL_DESCRIPTORS, signalDescriptorFor } from "../src/signals/registry.ts";
import type { ProductType } from "../src/types.ts";

// The step-primitive contract suite — the analog of test/work-source-contract.test.ts for the
// WorkSource charter. Parametrized over EVERY registered step primitive + product + signal, it is
// the executable definition of "the declarations are coherent, so composing them is reliable".

const PRODUCT_VOCAB: readonly ProductType[] = [
  "work_spec",
  "work_raw",
  "commits",
  "handoff",
  "evidence",
  "pull_request",
  "bounce_feedback",
  "human_reply",
  "close_reference",
];

const promptPath = (slug: string) => fileURLToPath(new URL(`../src/prompts/${slug}.md`, import.meta.url));

describe("StepDescriptor contract (per registered step primitive)", () => {
  for (const d of STEP_DESCRIPTORS) {
    describe(`step "${d.name}"`, () => {
      it("produces handoff (mandatory on every step)", () => {
        expect(d.produces).toContain("handoff");
      });

      it("consumes/produces are drawn only from the closed product vocabulary", () => {
        for (const c of d.consumes) expect(PRODUCT_VOCAB).toContain(c.type);
        for (const p of d.produces) expect(PRODUCT_VOCAB).toContain(p);
      });

      it("every produced AND consumed product maps to a registered ProductCapability", () => {
        for (const p of [...d.produces, ...d.consumes.map((c) => c.type)]) {
          expect(() => productCapabilityFor(p)).not.toThrow();
        }
      });

      it("has a shipped base prompt file, OR requires a prompt_file (the generic custom step)", () => {
        if (d.basePrompt) {
          expect(existsSync(promptPath(d.basePrompt.slug))).toBe(true);
        } else {
          expect(d.promptFileRequired).toBe(true);
        }
      });

      it("a read-only step never declares produces:commits (declared AND enforced)", () => {
        if (d.controls.posture?.readOnly) expect(d.produces).not.toContain("commits");
      });

      it("every guard declares a non-empty escalation reason; capture_cap resets on forward_entry", () => {
        for (const g of d.guards) {
          expect(g.escalationReason.length).toBeGreaterThan(0);
          if (g.kind === "capture_cap") {
            expect(g.reset).toBe("forward_entry");
            expect(g.cumulative).toBe(false);
            expect(g.counterScope).toBe("run+step+guard"); // counter lives in the generalized guard_counters table
          }
          if (g.kind === "heartbeat") expect(g.requiresProduct).toBe("commits");
        }
      });

      it("a bounce emitter only makes sense with an evidence/gate posture (has a base prompt to bounce from)", () => {
        // Belt-composition resolves the actual target; here we just assert the emit-side shape.
        if (d.controls.bounce) expect(d.controls.bounce.toEarliestConsumerOf).toBe("bounce_feedback");
      });
    });
  }

  it("STEP_WATCHDOG_ATTENTION == the union of autoRescueOnDone guard reasons", () => {
    const union = new Set(
      STEP_DESCRIPTORS.flatMap((d) => d.guards)
        .filter((g) => g.autoRescueOnDone)
        .map((g) => g.escalationReason),
    );
    expect([...union].sort()).toEqual(["capture_limit", "layout_wait_timeout", "step_budget", "step_stalled"]);
  });

  it("the shipped primitives are exactly work/evidence/review/pr/custom", () => {
    expect(STEP_DESCRIPTORS.map((d) => d.name).sort()).toEqual(["custom", "evidence", "pr", "review", "work"]);
  });
});

describe("SignalDescriptor contract", () => {
  it("signal names are unique and every signal takes a `key`", () => {
    const names = SIGNAL_DESCRIPTORS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SIGNAL_DESCRIPTORS) expect(s.args.some((a) => a.name === "key")).toBe(true);
  });

  it("capture-attempt carries an explicit `step` arg (a belt may legitimately have >1 evidence step)", () => {
    expect(signalDescriptorFor("capture-attempt")!.args.some((a) => a.name === "step")).toBe(true);
  });

  it("non-monotonic signals wait on the run lock; monotonic ones are fire-and-forget", () => {
    // bounce/ask-human/capture-attempt all cause a non-monotonic run mutation (step rewind, phase
    // flip to waiting_for_human, or a cap-exceeded park) → must not be dropped on lock contention.
    expect(signalDescriptorFor("bounce")!.lockDiscipline).toBe("waiting");
    expect(signalDescriptorFor("ask-human")!.lockDiscipline).toBe("waiting");
    expect(signalDescriptorFor("capture-attempt")!.lockDiscipline).toBe("waiting");
    expect(signalDescriptorFor("step-done")!.lockDiscipline).toBe("fire-and-forget");
  });
});

describe("ProductCapability contract", () => {
  it("every capability's product is in the closed vocabulary and unique", () => {
    const products = PRODUCT_CAPABILITIES.map((p) => p.product);
    expect(new Set(products).size).toBe(products.length);
    for (const p of products) expect(PRODUCT_VOCAB).toContain(p);
  });

  it("pull_request carries adoption identity + a terminal watch + the produce→in_review effect", () => {
    const c = productCapabilityFor("pull_request");
    expect(c.adoption?.observedCompletion).toContain("MERGED");
    expect(c.adoption?.perAttemptBranchUid).toBe(true);
    expect(c.watch?.subPhase).toBe("reviewing");
    expect(c.watch?.idleHoldsSlot).toBe(false); // idle PR-watch holds no max_active_workspaces slot
    expect(c.watch?.resolver.reusesPaneOf).toBe("pull_request");
    expect(c.effectOnProduce?.to).toBe("in_review");
  });

  it("evidence enables the durable S3 upload outbox + the capture signals", () => {
    const c = productCapabilityFor("evidence");
    expect(c.outbox).toBe("evidence_uploads");
    expect(c.signals).toContain("capture-attempt");
    expect(c.signals).toContain("evidence-upload");
  });
});
