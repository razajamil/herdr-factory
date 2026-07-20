import { describe, it, expect } from "vitest";
import {
  type BranchTaxonomy,
  DEFAULT_BRANCH_TAXONOMY,
  branchName,
  prefixForType,
  renderWorkspaceName,
  renderWorkVars,
  slugify,
} from "../src/core/branch.ts";

describe("prefixForType", () => {
  it("maps issue types to prefixes with the default taxonomy (substring)", () => {
    expect(prefixForType("Bug")).toBe("fix");
    expect(prefixForType("Dev bug")).toBe("fix");
    expect(prefixForType("Defect")).toBe("fix");
    expect(prefixForType("Chore")).toBe("chore");
    expect(prefixForType("Sub-task")).toBe("chore");
    expect(prefixForType("Task")).toBe("chore");
    expect(prefixForType("Story")).toBe("feature");
    expect(prefixForType("New Feature")).toBe("feature");
  });

  it("uses a resolved taxonomy when one is given (case-insensitive substring, first key wins)", () => {
    const tax: BranchTaxonomy = { prefixes: { story: "feat", epic: "feat" }, default: "chore", slugMax: 20, fullSlugMax: 50 };
    expect(prefixForType("Story", tax)).toBe("feat"); // mapped
    expect(prefixForType("STORY", tax)).toBe("feat"); // case-insensitive
    expect(prefixForType("Tech Story", tax)).toBe("feat"); // substring
    expect(prefixForType("Bug", tax)).toBe("chore"); // unmapped → configured default
  });
});

describe("branchName", () => {
  it("builds prefix/KEY-slug, lowercased + kebab + capped", () => {
    expect(branchName("RWR-1234", "Dev bug", "Balance sheet date range is showing incorrect!!")).toBe(
      "fix/RWR-1234-balance-sheet-date-range-is-showing-incorrect",
    );
    expect(branchName("RWR-9", "Chore", "upgrade eslint")).toBe("chore/RWR-9-upgrade-eslint");
  });
  it("falls back to 'work' for an empty slug", () => {
    expect(branchName("RWR-1", "Story", "!!!")).toBe("feature/RWR-1-work");
  });
  it("default behaviour is unchanged when no template is given", () => {
    expect(branchName("RWR-9", "Chore", "upgrade eslint", undefined)).toBe("chore/RWR-9-upgrade-eslint");
  });
  it("appends a per-run uid suffix when given — same ticket, different uid → distinct branch", () => {
    expect(branchName("RWR-9", "Chore", "upgrade eslint", undefined, "a1b2c3")).toBe("chore/RWR-9-upgrade-eslint-a1b2c3");
    expect(branchName("RWR-9", "Chore", "upgrade eslint", undefined, "deadbe")).toBe("chore/RWR-9-upgrade-eslint-deadbe");
  });

  it("passing the default taxonomy explicitly is byte-identical to passing none (today's names, pinned)", () => {
    // The "no branch: block ⇒ identical branch names to today" guarantee, at the function level.
    for (const [key, type, summary] of [
      ["RWR-1234", "Dev bug", "Balance sheet date range is showing incorrect!!"],
      ["RWR-9", "Chore", "upgrade eslint"],
      ["RWR-1", "Story", "!!!"],
    ] as const) {
      expect(branchName(key, type, summary, undefined, undefined, DEFAULT_BRANCH_TAXONOMY)).toBe(branchName(key, type, summary));
    }
  });

  it("honors a resolved taxonomy: a story→feat mapping yields feat/… and slug caps apply", () => {
    const tax: BranchTaxonomy = { prefixes: { story: "feat" }, default: "chore", slugMax: 6, fullSlugMax: 12 };
    // {{semantic_work_prefix}} comes from the map; {{work_slug}} is capped at slugMax.
    expect(branchName("RWR-5", "Story", "add a thing", undefined, undefined, tax)).toBe("feat/RWR-5-add-a-thing");
    expect(
      renderWorkspaceName("{{semantic_work_prefix}}/{{work_id}}-{{work_slug}}", { key: "RWR-5", type: "Story", summary: "add a shiny thing" }, tax),
    ).toBe("feat/RWR-5-add-a"); // slugify("add a shiny thing", 6) = "add-a" (cut lands on the dash → trimmed)
    // An unmapped type falls to the configured default prefix.
    expect(branchName("RWR-6", "Bug", "boom", undefined, undefined, tax)).toBe("chore/RWR-6-boom");
  });
});

describe("slugify", () => {
  it("kebabs, lowercases, caps, and trims a trailing dash", () => {
    expect(slugify("[UI] Fix chargeable item list loading state", 20)).toBe("ui-fix-chargeable-it");
    expect(slugify("a".repeat(19) + " bbb", 20)).toBe("a".repeat(19)); // cut lands on the dash → trimmed
    expect(slugify("!!!", 20)).toBe("");
  });
});

describe("renderWorkspaceName", () => {
  const t = { key: "RWR-17202", type: "Bug", summary: "[UI] Fix chargeable item list loading state" };

  it("interpolates the user's example template (short slug capped at 20)", () => {
    expect(renderWorkspaceName("fix/{{work_id}}-{{work_slug}}", t)).toBe("fix/RWR-17202-ui-fix-chargeable-it");
  });
  it("supports prefix/type/full-slug vars", () => {
    expect(renderWorkspaceName("{{semantic_work_prefix}}/{{work_id}}-{{work_slug}}", t)).toBe(
      "fix/RWR-17202-ui-fix-chargeable-it",
    );
    expect(renderWorkspaceName("{{work_type}}/{{work_id}}", t)).toBe("bug/RWR-17202");
    expect(renderWorkspaceName("{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}", t)).toBe(
      "fix/RWR-17202-ui-fix-chargeable-item-list-loading-state",
    );
  });
  it("tolerates whitespace in the braces and drops unknown vars", () => {
    expect(renderWorkspaceName("fix/{{ work_id }}{{nope}}", t)).toBe("fix/RWR-17202");
  });
  it("sanitises spaces / illegal chars and tidies separators", () => {
    expect(renderWorkspaceName("wip/{{work_id}} draft?", t)).toBe("wip/RWR-17202-draft");
    expect(renderWorkspaceName("{{semantic_work_prefix}}//{{work_id}}", t)).toBe("fix/RWR-17202");
  });
});

describe("renderWorkVars (PR-title-style templates — same vars, NO git sanitisation)", () => {
  const t = { key: "RWR-17202", type: "Bug", summary: "[UI] Fix chargeable item list loading state" };

  it("interpolates the work-item vars", () => {
    expect(renderWorkVars("{{work_id}}: {{work_type}}", t)).toBe("RWR-17202: bug");
    expect(renderWorkVars("[{{semantic_work_prefix}}] {{work_id}}", t)).toBe("[fix] RWR-17202");
  });

  it("keeps spaces and case verbatim (unlike renderWorkspaceName, which sanitises to a ref)", () => {
    // A real title, not a branch: spaces stay spaces, case is preserved — no ref sanitisation.
    expect(renderWorkVars("{{work_id}} Fix It Now", t)).toBe("RWR-17202 Fix It Now");
    expect(renderWorkspaceName("{{work_id}} Fix It Now", t)).toBe("RWR-17202-Fix-It-Now");
  });

  it("tolerates whitespace in the braces and drops unknown vars", () => {
    expect(renderWorkVars("{{ work_id }}{{nope}}!", t)).toBe("RWR-17202!");
  });
});
