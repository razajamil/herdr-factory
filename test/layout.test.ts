import { describe, it, expect } from "vitest";
import { globMatch, resolveBeltLayout, buildPlan, splitRatioArg, clampRatio, applyLayout } from "../src/core/layout.ts";
import type { BeltConfig, LayoutConfig } from "../src/config.ts";
import type { Deps } from "../src/core/deps.ts";

// A minimal resolved belt (only the fields resolveBeltLayout reads matter).
function belt(over: Partial<BeltConfig> = {}): BeltConfig {
  return { name: "b", beltType: "custom", source: "s", priority: 100, active: true, steps: [], watchPr: false, ...over };
}

describe("globMatch", () => {
  it("* matches any run of chars incl slashes, anchored full-string", () => {
    expect(globMatch("fix/rwr-*", "fix/rwr-123-foo")).toBe(true);
    expect(globMatch("fix/rwr-*", "hotfix/rwr-1")).toBe(false);
    expect(globMatch("*", "anything/at/all")).toBe(true);
    expect(globMatch("feature/*", "feature/")).toBe(true);
  });
  it("? matches exactly one char", () => {
    expect(globMatch("v?", "v1")).toBe(true);
    expect(globMatch("v?", "v12")).toBe(false);
  });
  it("a literal pattern must match the whole string", () => {
    expect(globMatch("main", "main")).toBe(true);
    expect(globMatch("main", "mains")).toBe(false);
  });
});

describe("resolveBeltLayout", () => {
  const layouts: LayoutConfig[] = [
    { id: "web", tabs: [{ panes: [{ setup: false }] }] },
    { id: "hot", tabs: [{ panes: [{ setup: false }] }] },
  ];
  it("first layout_matching rule whose glob matches the branch wins", () => {
    const b = belt({ defaultLayout: "web", layoutMatching: [{ worktreePattern: "hotfix/*", layout: "hot" }] });
    expect(resolveBeltLayout(b, "hotfix/x", layouts)?.id).toBe("hot");
  });
  it("no matching rule falls through to default_layout", () => {
    const b = belt({ defaultLayout: "web", layoutMatching: [{ worktreePattern: "hotfix/*", layout: "hot" }] });
    expect(resolveBeltLayout(b, "fix/x", layouts)?.id).toBe("web");
  });
  it("no branch (e.g. detached) uses default_layout", () => {
    const b = belt({ defaultLayout: "web", layoutMatching: [{ worktreePattern: "hotfix/*", layout: "hot" }] });
    expect(resolveBeltLayout(b, undefined, layouts)?.id).toBe("web");
  });
  it("no default and no matching rule ⇒ undefined (nothing built)", () => {
    const b = belt({ layoutMatching: [{ worktreePattern: "hotfix/*", layout: "hot" }] });
    expect(resolveBeltLayout(b, "fix/x", layouts)).toBeUndefined();
  });
  it("a rule pointing at a missing layout id is skipped", () => {
    const b = belt({ defaultLayout: "web", layoutMatching: [{ worktreePattern: "*", layout: "ghost" }] });
    expect(resolveBeltLayout(b, "any", layouts)?.id).toBe("web");
  });
});

describe("buildPlan", () => {
  const layout: LayoutConfig = {
    id: "web",
    setup: { command: "mise run setup", blocking: true },
    tabs: [
      {
        title: "main",
        panes: [
          { title: "agent", command: "claude", setup: true },
          { title: "editor", command: "nvim", split: "right", setup: false },
        ],
      },
      {
        title: "dev",
        panes: [
          { title: "server", setup: false },
          { title: "logs", split: "down", setup: false },
        ],
      },
    ],
  };

  it("reuses the root tab/pane, splits later panes from the previous, runs setup before its command", () => {
    expect(buildPlan(layout, "/work")).toEqual([
      { kind: "reuseTab", tab: "t0", title: "main" },
      { kind: "renamePane", pane: "t0p0", title: "agent" },
      { kind: "runSetup", pane: "t0p0", command: "mise run setup", blocking: true },
      { kind: "run", pane: "t0p0", command: "claude" },
      { kind: "split", pane: "t0p1", from: "t0p0", direction: "right", ratio: undefined, size: undefined, cwd: "/work" },
      { kind: "renamePane", pane: "t0p1", title: "editor" },
      { kind: "run", pane: "t0p1", command: "nvim" },
      { kind: "createTab", tab: "t1", pane: "t1p0", title: "dev", cwd: "/work" },
      { kind: "renamePane", pane: "t1p0", title: "server" },
      { kind: "split", pane: "t1p1", from: "t1p0", direction: "down", ratio: undefined, size: undefined, cwd: "/work" },
      { kind: "renamePane", pane: "t1p1", title: "logs" },
    ]);
  });

  it("a blocking setup precedes the first createTab (no later tab spawns until it finishes)", () => {
    const steps = buildPlan(layout);
    const setupIdx = steps.findIndex((s) => s.kind === "runSetup");
    const firstCreate = steps.findIndex((s) => s.kind === "createTab");
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(firstCreate).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeLessThan(firstCreate);
  });
});

describe("splitRatioArg / clampRatio", () => {
  it("inverts a pane size into the from-pane's kept share", () => {
    expect(splitRatioArg(undefined, undefined, undefined)).toBeUndefined();
    expect(splitRatioArg(0.3, undefined, undefined)).toBe(0.3); // legacy ratio passes through
    expect(splitRatioArg(undefined, { percent: 30 }, undefined)).toBe(0.7);
    expect(splitRatioArg(undefined, { cells: 50 }, 200)).toBe(0.75);
    expect(splitRatioArg(undefined, { cells: 300 }, 200)).toBe(0.01); // cell size ≥ extent → clamp
    expect(splitRatioArg(undefined, { cells: 40 }, undefined)).toBeUndefined(); // no extent → herdr default
  });
  it("clampRatio keeps ratios inside (0, 1)", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(-3)).toBe(0.01);
    expect(clampRatio(5)).toBe(0.99);
    expect(clampRatio(NaN)).toBeUndefined();
  });
});

describe("applyLayout", () => {
  // A deps stub whose herdr records the herdr commands the runner issues, in order.
  function stubDeps(rec: string[]): Deps {
    const herdr = {
      tabRename: async (id: string, label: string) => void rec.push(`tabRename ${id} ${label}`),
      tabCreate: async (ws: string, opts: { label?: string; cwd?: string }) => {
        rec.push(`tabCreate ${ws} label=${opts.label ?? ""} cwd=${opts.cwd ?? ""}`);
        return { tabId: "TAB", paneId: "PANE" };
      },
      paneSplit: async (from: string, opts: { direction: string; ratio?: number; cwd?: string }) => {
        rec.push(`paneSplit ${from} ${opts.direction} ratio=${opts.ratio ?? ""}`);
        return "SPLIT";
      },
      paneRename: async (id: string, label: string) => void rec.push(`paneRename ${id} ${label}`),
      paneRun: async (id: string, cmd: string) => void rec.push(`paneRun ${id} ${cmd}`),
      paneExtent: async () => 200,
      waitOutput: async () => 'HERDR_FACTORY_SETUP_DONE_x 0',
    };
    return { config: { repoName: "demo" }, herdr, sleep: async () => {}, uid: () => "uid1", log: () => {} } as unknown as Deps;
  }

  it("issues herdr commands in plan order, inverts a % size, runs blocking setup before the command", async () => {
    const rec: string[] = [];
    const layout: LayoutConfig = {
      id: "web",
      setup: { command: "setup.sh", blocking: true },
      tabs: [
        {
          title: "main",
          panes: [
            { title: "agent", command: "claude", setup: true },
            { title: "editor", command: "nvim", split: "right", size: { percent: 30 }, setup: false },
          ],
        },
        { title: "dev", panes: [{ title: "server", command: "pnpm dev", setup: false }] },
      ],
    };
    await applyLayout(stubDeps(rec), { workspaceId: "W", rootTabId: "T0", rootPaneId: "P0", cwd: "/work" }, layout);
    expect(rec).toEqual([
      "tabRename T0 main",
      "paneRename P0 agent",
      `paneRun P0 ( setup.sh ) ; printf 'HERDR_FACTORY_SETUP_DONE_%s %s\\n' 'uid1' "$?"`,
      "paneRun P0 claude",
      "paneSplit P0 right ratio=0.7", // 30% new pane ⇒ from pane keeps 0.7
      "paneRename SPLIT editor",
      "paneRun SPLIT nvim",
      "tabCreate W label=dev cwd=/work",
      "paneRename PANE server",
      "paneRun PANE pnpm dev",
    ]);
  });
});
