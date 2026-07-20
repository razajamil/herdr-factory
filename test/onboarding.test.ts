// The onboarding "pointer chain" — each first-run stage ends by naming the next stage. These pin
// the exact forward link each builder emits so the chain (install → init → doctor → run → start →
// watch) can't silently break its wording. The builders are pure, so no fixtures are needed.
import { describe, it, expect } from "vitest";
import { afterDoctorHint, afterInstallHint, afterStartHint } from "../src/onboarding.ts";

describe("onboarding pointer chain", () => {
  it("install → points at `init` (configure a repo)", () => {
    const hint = afterInstallHint();
    expect(hint).toContain("herdr-factory init");
    expect(hint.toLowerCase()).toContain("next:");
  });

  it("start → points at watching it (the TUI / status)", () => {
    const hint = afterStartHint();
    expect(hint).toContain("herdr-factory --repo <name> status");
    expect(hint.toLowerCase()).toContain("next:");
  });

  describe("doctor → the forward link depends on where you are", () => {
    it("any ✗ → resolve them and re-run doctor (never pushes forward while broken)", () => {
      const hint = afterDoctorHint({ repo: "app", deep: true, failed: true });
      expect(hint).toContain("Resolve");
      expect(hint).toContain("herdr-factory doctor");
      expect(hint).not.toContain("run --follow"); // don't advance a failing setup
    });

    it("✓ machine-wide (no repo) → point it at a repo with `init`", () => {
      const hint = afterDoctorHint({ repo: undefined, deep: false, failed: false });
      expect(hint).toContain("herdr-factory init");
      expect(hint).toContain("doctor --deep");
    });

    it("✓ repo, shallow → verify the live setup with a deep repo doctor", () => {
      const hint = afterDoctorHint({ repo: "app", deep: false, failed: false });
      expect(hint).toContain("herdr-factory --repo app doctor --deep");
      expect(hint).not.toContain("run --follow"); // deep verification comes before the first run
    });

    it("✓ repo, deep → take the first live run", () => {
      const hint = afterDoctorHint({ repo: "app", deep: true, failed: false });
      expect(hint).toContain("herdr-factory --repo app run --follow");
    });
  });
});
