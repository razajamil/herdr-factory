import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productActiveFor, stripInactiveProductBlocks } from "../src/core/step.ts";
import type { ProductType } from "../src/types.ts";

// The render-time half of design §8: an OPTIONAL consume unsatisfied by the belt is DROPPED — no
// @@TOKEN@@ injected, no orphaned clause — so a work→review→pr belt never points the reviewer/PR
// step at evidence that was never captured.

const prompt = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/prompts/${rel}`, import.meta.url)), "utf8");

const step = (name: string, produces: ProductType[], consumes: ProductType[] = []) => ({
  name,
  produces,
  consumes: consumes.map((type) => ({ type, required: false })),
});

const WORK = step("work", ["commits", "handoff"]);
const EVIDENCE = step("evidence", ["evidence", "handoff"], ["commits"]);
const REVIEW = step("review", ["handoff"], ["commits", "evidence"]);
const PR = step("pr", ["pull_request", "handoff"], ["commits", "evidence", "close_reference"]);

describe("productActiveFor — belt dataflow gating", () => {
  it("evidence is INACTIVE for a consumer when no upstream step produces it (work→review→pr)", () => {
    const steps = [WORK, REVIEW, PR];
    expect(productActiveFor(steps, REVIEW, "jira")("evidence")).toBe(false);
    expect(productActiveFor(steps, PR, "jira")("evidence")).toBe(false);
  });

  it("evidence is ACTIVE for a consumer when an upstream step produces it (work→evidence→review→pr)", () => {
    const steps = [WORK, EVIDENCE, REVIEW, PR];
    expect(productActiveFor(steps, REVIEW, "jira")("evidence")).toBe(true);
    expect(productActiveFor(steps, PR, "jira")("evidence")).toBe(true);
  });

  it("the evidence producer itself is always active for evidence (its own produce)", () => {
    expect(productActiveFor([WORK, EVIDENCE], EVIDENCE, "jira")("evidence")).toBe(true);
  });

  it("a required upstream product (commits) is active; an unproduced one is not", () => {
    const active = productActiveFor([WORK, REVIEW, PR], REVIEW, "jira");
    expect(active("commits")).toBe(true); // work produced it
    expect(active("pull_request")).toBe(false); // only PR (downstream) produces it
  });

  it("close_reference is active only for the source that produces it (github_issues, not jira)", () => {
    const steps = [WORK, PR];
    expect(productActiveFor(steps, PR, "github_issues")("close_reference")).toBe(true);
    expect(productActiveFor(steps, PR, "jira")("close_reference")).toBe(false);
  });
});

describe("stripInactiveProductBlocks — @@WHEN:product@@ … @@END@@", () => {
  it("drops the whole block (prose + tokens) when inactive, keeps inner (minus markers) when active", () => {
    const body = "keep A.@@WHEN:evidence@@ read @@EVIDENCE_DIR@@@@END@@ keep B.";
    expect(stripInactiveProductBlocks(body, () => false)).toBe("keep A. keep B.");
    expect(stripInactiveProductBlocks(body, () => true)).toBe("keep A. read @@EVIDENCE_DIR@@ keep B.");
  });

  it("handles multiple independent blocks", () => {
    const body = "@@WHEN:evidence@@X@@END@@-@@WHEN:commits@@Y@@END@@";
    expect(stripInactiveProductBlocks(body, (p) => p === "commits")).toBe("-Y");
  });

  it("returns a body with no blocks unchanged", () => {
    expect(stripInactiveProductBlocks("plain @@KEY@@ body", () => false)).toBe("plain @@KEY@@ body");
  });
});

describe("shipped consumer prompts gate every evidence reference", () => {
  for (const rel of ["review.md", "pr.md", "github_issues/pr.md"]) {
    it(`${rel}: dropping evidence leaves no dangling evidence token and no leftover markers`, () => {
      const dropped = stripInactiveProductBlocks(prompt(rel), () => false);
      expect(dropped).not.toMatch(/@@EVIDENCE_DIR@@|@@EVIDENCE_UPLOAD_CMD@@|@@CAPTURE_ATTEMPT_CMD@@/);
      expect(dropped).not.toMatch(/@@WHEN:|@@END@@/);
    });

    it(`${rel}: keeping evidence retains the evidence reference and strips only the markers`, () => {
      const kept = stripInactiveProductBlocks(prompt(rel), () => true);
      expect(kept).toContain("@@EVIDENCE_DIR@@");
      expect(kept).not.toMatch(/@@WHEN:|@@END@@/);
    });
  }
});
