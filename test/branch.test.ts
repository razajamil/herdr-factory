import { describe, it, expect } from "vitest";
import { branchName, prefixForType, renderWorkspaceName, slugify } from "../src/core/branch.ts";

describe("prefixForType", () => {
  it("maps issue types to prefixes (substring)", () => {
    expect(prefixForType("Bug")).toBe("fix");
    expect(prefixForType("Dev bug")).toBe("fix");
    expect(prefixForType("Defect")).toBe("fix");
    expect(prefixForType("Chore")).toBe("chore");
    expect(prefixForType("Sub-task")).toBe("chore");
    expect(prefixForType("Task")).toBe("chore");
    expect(prefixForType("Story")).toBe("feature");
    expect(prefixForType("New Feature")).toBe("feature");
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
