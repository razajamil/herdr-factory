import { describe, it, expect } from "vitest";
import { branchName, prefixForType } from "../src/core/branch.ts";

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
});
