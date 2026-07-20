import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROMPT_TOKENS,
  availablePromptTokens,
  validatePromptBody,
  type PromptStepContext,
} from "../src/prompts/contract.ts";
import { PRODUCT_CAPABILITIES, productCapabilityFor } from "../src/products/registry.ts";
import type { GuardKind, ProductType } from "../src/types.ts";

// Step contexts mirroring the three shapes the renderer produces. `isActive` is productActiveFor's
// result; `guardKinds` is step.guards' kinds. The renderer builds exactly this ctx and validates the
// user prompt against it, so these are the real inputs.
const universalOnly: PromptStepContext = { isActive: () => false, guardKinds: new Set() };
const evidenceActive: PromptStepContext = { isActive: (p) => p === "evidence", guardKinds: new Set() };
const evidenceWithLock: PromptStepContext = {
  isActive: (p) => p === "evidence",
  guardKinds: new Set<GuardKind>(["exclusive_resource"]),
};

describe("availablePromptTokens", () => {
  it("universal tokens are always available; scoped tokens only when active/declared", () => {
    const u = availablePromptTokens(universalOnly);
    expect(u.has("@@KEY@@")).toBe(true);
    expect(u.has("@@BOUNCE_CMD@@")).toBe(true); // universal even when empty
    expect(u.has("@@EVIDENCE_DIR@@")).toBe(false);
    expect(u.has("@@CAPTURE_LOCK_ACQUIRE_CMD@@")).toBe(false);
  });

  it("evidence tokens appear when evidence is active", () => {
    const e = availablePromptTokens(evidenceActive);
    expect(e.has("@@EVIDENCE_DIR@@")).toBe(true);
    expect(e.has("@@CAPTURE_ATTEMPT_CMD@@")).toBe(true);
    expect(e.has("@@CAPTURE_LOCK_ACQUIRE_CMD@@")).toBe(false); // guard not declared
  });

  it("capture-lock tokens appear only when the exclusive_resource guard is declared", () => {
    expect(availablePromptTokens(evidenceWithLock).has("@@CAPTURE_LOCK_RELEASE_CMD@@")).toBe(true);
  });
});

describe("validatePromptBody — tokens", () => {
  it("accepts a prompt using only universal tokens", () => {
    expect(validatePromptBody("Do @@KEY@@ on @@BRANCH@@; write @@HANDOFF_OUT@@.", universalOnly)).toEqual([]);
  });

  it("rejects an unknown token", () => {
    const problems = validatePromptBody("Fix @@NOPE@@ now.", universalOnly);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@@NOPE@@");
    expect(problems[0]).toContain("not a known prompt token");
  });

  it("rejects a known token used out of scope (evidence token in a no-evidence belt)", () => {
    const problems = validatePromptBody("See @@EVIDENCE_DIR@@.", universalOnly);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@@EVIDENCE_DIR@@");
    expect(problems[0]).toContain("evidence");
  });

  it("accepts the same evidence token when evidence is active for the step", () => {
    expect(validatePromptBody("See @@EVIDENCE_DIR@@.", evidenceActive)).toEqual([]);
  });

  it("rejects a guard token on a step that doesn't declare the guard", () => {
    expect(validatePromptBody("@@CAPTURE_LOCK_ACQUIRE_CMD@@", evidenceActive)).toHaveLength(1);
    expect(validatePromptBody("@@CAPTURE_LOCK_ACQUIRE_CMD@@", evidenceWithLock)).toEqual([]);
  });

  it("reports each distinct offending token once", () => {
    const problems = validatePromptBody("@@NOPE@@ @@NOPE@@ @@ALSO_BAD@@", universalOnly);
    expect(problems).toHaveLength(2);
  });

  it("ignores non-token @@…@@ noise and plain text", () => {
    expect(validatePromptBody("email me@@example (not a token) and run @@STEP_DONE_CMD@@", universalOnly)).toEqual([]);
  });
});

describe("validatePromptBody — @@WHEN@@ product gates", () => {
  it("a gated scoped token passes even when its product is inactive (the clause is dropped)", () => {
    const body = "Implement it.@@WHEN:evidence@@ Check @@EVIDENCE_DIR@@.@@END@@";
    expect(validatePromptBody(body, universalOnly)).toEqual([]);
    expect(validatePromptBody(body, evidenceActive)).toEqual([]);
  });

  it("a bare evidence token OUTSIDE a gate is still rejected in a no-evidence belt", () => {
    expect(validatePromptBody("Check @@EVIDENCE_DIR@@.", universalOnly)).toHaveLength(1);
  });

  it("rejects a malformed gate", () => {
    expect(validatePromptBody("@@WHEN@@ x @@END@@", universalOnly)[0]).toContain("malformed");
  });

  it("rejects an unknown product in a gate", () => {
    const problems = validatePromptBody("@@WHEN:evidnce@@ x @@END@@", universalOnly);
    expect(problems[0]).toContain("unknown product");
  });

  it("rejects an unclosed gate", () => {
    expect(validatePromptBody("@@WHEN:evidence@@ x", universalOnly)[0]).toContain("closing @@END@@");
  });

  it("rejects a stray @@END@@", () => {
    expect(validatePromptBody("x @@END@@", universalOnly)[0]).toContain("without a matching");
  });

  it("rejects nested gates", () => {
    const problems = validatePromptBody("@@WHEN:evidence@@@@WHEN:commits@@x@@END@@@@END@@", universalOnly);
    expect(problems.some((p) => p.includes("nested"))).toBe(true);
  });

  it("structural problems are reported alone (no misleading token errors from leftover markers)", () => {
    const problems = validatePromptBody("x @@END@@ @@NOPE@@", universalOnly);
    expect(problems.every((p) => !p.includes("@@NOPE@@"))).toBe(true);
  });
});

describe("the empty / no-prompt case", () => {
  it("an empty body has no problems", () => {
    expect(validatePromptBody("", universalOnly)).toEqual([]);
  });
});

// ── Anti-drift guards: the contract catalog must stay pinned to the code + docs it governs. ──

describe("contract ↔ registry ↔ renderer ↔ docs stay in sync", () => {
  const evidenceContractTokens = PROMPT_TOKENS.filter(
    (t) => t.scope.kind === "product" && t.scope.product === "evidence",
  )
    .map((t) => t.token)
    .sort();

  it("the contract's evidence tokens equal the product-capability registry's", () => {
    const registry = [...(productCapabilityFor("evidence").tokens ?? [])].sort();
    expect(evidenceContractTokens).toEqual(registry);
  });

  it("only known ProductTypes are referenced by product-scoped tokens", () => {
    const products = new Set<ProductType>(PRODUCT_CAPABILITIES.map((p) => p.product));
    for (const t of PROMPT_TOKENS) {
      if (t.scope.kind === "product") expect(products.has(t.scope.product), t.token).toBe(true);
    }
  });

  it("every catalog token is actually substituted by the renderer (appears as a quoted key in step.ts)", () => {
    // Guards the failure mode a pure-unit test can't see: the contract listing a token step.ts never
    // injects, which would let the validator accept a prompt that then reaches the agent unrendered.
    const stepSrc = readFileSync(fileURLToPath(new URL("../src/core/step.ts", import.meta.url)), "utf8");
    for (const t of PROMPT_TOKENS) {
      expect(stepSrc.includes(`"${t.token}"`), `${t.token} is in the contract but not injected by step.ts`).toBe(true);
    }
  });

  it("every catalog token is documented in docs/PROMPTS.md", () => {
    const doc = readFileSync(fileURLToPath(new URL("../docs/PROMPTS.md", import.meta.url)), "utf8");
    for (const t of PROMPT_TOKENS) {
      expect(doc.includes(t.token), `${t.token} is missing from docs/PROMPTS.md`).toBe(true);
    }
  });
});
