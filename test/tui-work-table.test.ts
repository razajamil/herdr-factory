import { describe, expect, it } from "vitest";
import { formatWorkTable } from "../src/tui/work-table.ts";

describe("dashboard work table", () => {
  it("renders the work summary first and one aligned column per step", () => {
    const table = formatWorkTable(["plan", "build", "review"], [
      { id: "HF-12", description: "Improve dashboard", statuses: ["done", "running", "pending"] },
      { id: "HF-2", description: "Fix login", statuses: ["eligible", "pending", "pending"] },
    ]);

    expect(table.header).toBe("WORK                    | plan     | build   | review ");
    expect(table.rows).toEqual([
      "HF-12 Improve dashboard | done     | running | pending",
      "HF-2 Fix login          | eligible | pending | pending",
    ]);
  });

  it("shortens long descriptions without removing the work id", () => {
    const table = formatWorkTable(["work"], [
      { id: "HF-123", description: "A very long description that should not consume the whole terminal width", statuses: ["waiting_for_human"] },
    ]);

    expect(table.rows[0]).toMatch(/^HF-123 /);
    expect(table.rows[0]).toContain("... | waiting_for_human");
  });
});
