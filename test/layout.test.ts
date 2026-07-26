import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globMatch, resolveBeltLayout, tabTree, splitRatio, clampRatio, applyLayout, deriveAgentName, HAND_BACK } from "../src/core/layout.ts";
import type { BeltConfig, LayoutAgent, LayoutConfig, LayoutPane, LayoutTab } from "../src/config.ts";
import type { LayoutNode } from "../src/types.ts";
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
    { id: "web", tabs: [{ panes: [{ persist: true, env: {}, setup: false }] }] },
    { id: "hot", tabs: [{ panes: [{ persist: true, env: {}, setup: false }] }] },
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

describe("tabTree — a configured tab becomes herdr's declarative pane tree", () => {
  const pane = (over: Partial<LayoutPane> = {}): LayoutPane => ({ persist: true, env: {}, setup: false, ...over });

  it("nests panes exactly as the sequential splits did: [a, b, c] ⇒ a | (b | c)", () => {
    const tab: LayoutTab = { title: "main", panes: [pane({ title: "agent" }), pane({ title: "editor", split: "right" }), pane({ title: "logs", split: "down" })] };
    expect(tabTree(tab, { cwd: "/work" })).toEqual({
      type: "split",
      direction: "right",
      ratio: 0.5, // unsized ⇒ herdr's even split
      first: { type: "pane", label: "agent", cwd: "/work" },
      second: {
        type: "split",
        direction: "down",
        ratio: 0.5,
        first: { type: "pane", label: "editor", cwd: "/work" },
        second: { type: "pane", label: "logs", cwd: "/work" },
      },
    });
  });

  it("a single-pane tab is a bare leaf, carrying its label/cwd/env", () => {
    expect(tabTree({ panes: [pane({ title: "only", env: { HERDR_FACTORY_TICKET: "K-1" } })] }, { cwd: "/w" })).toEqual({
      type: "pane",
      label: "only",
      cwd: "/w",
      env: { HERDR_FACTORY_TICKET: "K-1" },
    });
  });

  it("inverts a % size into the FIRST side's kept share", () => {
    const tree = tabTree({ panes: [pane(), pane({ split: "right", size: { percent: 30 } })] });
    expect(tree).toMatchObject({ type: "split", ratio: 0.7 });
  });

  it("resolves a fixed `cells` size against the box actually being split", () => {
    // 200x50 tab: a 50-cell-wide pane 1 leaves 150/200 = 0.75 for pane 0. Pane 2 then splits off
    // PANE 1 (a 50-col box, not the whole tab), so its 30 cells leave 20/50 = 0.4 — exactly what the
    // old runner computed by measuring the from-pane after each split.
    const tab: LayoutTab = { panes: [pane(), pane({ split: "right", size: { cells: 50 } }), pane({ split: "right", size: { cells: 30 } })] };
    const tree = tabTree(tab, { box: { cols: 200, rows: 50 } });
    expect(tree).toMatchObject({ ratio: 0.75, second: { ratio: 0.4 } });
  });

  it("a `cells` size with no measured box falls back to an even split (never a degenerate pane)", () => {
    expect(tabTree({ panes: [pane(), pane({ split: "down", size: { cells: 10 } })] })).toMatchObject({ ratio: 0.5 });
  });
});

describe("splitRatio / clampRatio", () => {
  const pane = (over: Partial<LayoutPane> = {}): LayoutPane => ({ persist: true, env: {}, setup: false, ...over });
  it("inverts a pane size into the first side's kept share", () => {
    expect(splitRatio(pane(), undefined)).toBeUndefined();
    expect(splitRatio(pane({ ratio: 0.3 }), undefined)).toBe(0.3); // legacy ratio passes through
    expect(splitRatio(pane({ size: { percent: 30 } }), undefined)).toBe(0.7);
    expect(splitRatio(pane({ size: { cells: 50 } }), 200)).toBe(0.75);
    expect(splitRatio(pane({ size: { cells: 300 } }), 200)).toBe(0.01); // cell size >= extent -> clamp
    expect(splitRatio(pane({ size: { cells: 40 } }), undefined)).toBeUndefined(); // unmeasurable
  });
  it("clampRatio keeps ratios inside (0, 1)", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(-3)).toBe(0.01);
    expect(clampRatio(5)).toBe(0.99);
    expect(clampRatio(NaN)).toBeUndefined();
  });
});

describe("tabTree — pane commands and agent panes", () => {
  const pane = (over: Partial<LayoutPane> = {}): LayoutPane => ({ persist: true, env: {}, setup: false, ...over });
  /** The script a pane runs, unwrapped from its login-shell argv. */
  function script(node: LayoutNode): string | undefined {
    const leaf = node.type === "pane" ? node : undefined;
    const argv = leaf?.command;
    if (!argv) return undefined;
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const rest = argv[2]!.replace(`exec ${'"${SHELL:-/bin/sh}"'} -lic `, "");
    return rest.slice(1, -1).replaceAll(`'\\''`, "'");
  }

  it("runs a command as the pane's PROCESS, in the user's login shell, then hands the pane back", () => {
    // Not typed into the shell: it can't race a shell that isn't listening and leaves no scrollback.
    // Login+interactive because that is what a typed command used to get — .zshrc PATH setup (mise,
    // asdf, nvm) has to keep applying.
    const tree = tabTree({ panes: [pane({ title: "editor", command: "nvim" })] });
    expect(script(tree)).toBe(`nvim; ${HAND_BACK}`);
    expect((tree as unknown as { command: string[] }).command[2]).toContain('exec "${SHELL:-/bin/sh}" -lic ');
  });

  it("persist: false lets the pane close with its command", () => {
    expect(script(tabTree({ panes: [pane({ command: "just build", persist: false })] }))).toBe("just build");
  });

  it("a plain pane gets no command at all — herdr's own shell is enough", () => {
    expect(script(tabTree({ panes: [pane({ title: "shell" })] }))).toBeUndefined();
  });

  it("an agent pane is created as a bare shell (herdr starts the agent into it afterwards)", () => {
    const tree = tabTree({ panes: [pane({ title: "agent", agent: { kind: "claude", args: [] } })] });
    expect(script(tree)).toBeUndefined();
    expect(tree).toEqual({ type: "pane", label: "agent" });
  });

  it("the setup pane records its exit status right after setup, before its own command", () => {
    const tab: LayoutTab = { panes: [pane({ command: "npm run dev", setup: true })] };
    const s = script(tabTree(tab, { setup: { command: "npm ci", statusPath: "/state/s.status" } }))!;
    expect(s).toBe(`npm ci; printf '%s' "$?" > '/state/s.status'; npm run dev; ${HAND_BACK}`);
    expect(s.indexOf("npm ci")).toBeLessThan(s.indexOf("/state/s.status"));
    expect(s.indexOf("/state/s.status")).toBeLessThan(s.indexOf("npm run dev"));
  });

  it("an agent pane that also runs setup still ends at a prompt (agent start needs one)", () => {
    const tab: LayoutTab = { panes: [pane({ agent: { kind: "claude", args: [] }, setup: true })] };
    const s = script(tabTree(tab, { setup: { command: "npm ci", statusPath: "/s" } }))!;
    expect(s.startsWith("npm ci; ")).toBe(true);
    expect(s.endsWith(HAND_BACK)).toBe(true);
  });

  it("carries the pane's env and survives a command containing quotes", () => {
    const tree = tabTree({ panes: [pane({ command: `echo 'it'"'"'s fine'`, env: { PORT: "3000" } })] }, { cwd: "/w" });
    expect(tree).toMatchObject({ env: { PORT: "3000" }, cwd: "/w" });
    expect((tree as unknown as { command: string[] }).command[2]).toContain(`'\\''`); // escaped, not lost
  });
});

describe("applyLayout", () => {
  const tmps: string[] = [];
  afterEach(() => {
    delete process.env.HERDR_FACTORY_STATE_ROOT;
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  /** A deps stub recording the herdr calls the runner issues, in order. layoutApply answers with one
   *  pane id per leaf, in tree order — which is how the runner maps configured panes to real ids. */
  function stubDeps(rec: string[], over: Partial<Record<string, unknown>> = {}): Deps {
    let tab = 0;
    const herdr = {
      tabArea: async () => ({ cols: 200, rows: 50 }),
      layoutApply: async (o: { workspaceId?: string; tabId?: string; tabLabel?: string; root: LayoutNode }) => {
        const leaves: string[] = [];
        const walk = (n: LayoutNode, path: string): void => {
          if (n.type === "pane") return void leaves.push(`t${tab}${path}`);
          walk(n.first, `${path}a`);
          walk(n.second, `${path}b`);
        };
        walk(o.root, "");
        rec.push(`layoutApply tab=${o.tabId ?? ""} ws=${o.workspaceId ?? ""} label=${o.tabLabel ?? ""}`);
        return { tabId: `TAB${tab++}`, paneIds: leaves };
      },
      paneAtShellPrompt: async () => true,
      agentAdopt: async (id: string, o: { name: string; kind: string; args?: readonly string[]; timeoutMs?: number }) => {
        rec.push(`agentAdopt ${id} name=${o.name} kind=${o.kind} args=${(o.args ?? []).join(" ")} timeout=${o.timeoutMs ?? ""}`);
        return true;
      },
      agentOpenPrompt: async (target: string, text: string, o: { settleTimeoutMs?: number } = {}) => {
        rec.push(`agentOpenPrompt ${target} "${text}" settle=${o.settleTimeoutMs ?? ""}`);
        return true;
      },
      reportPaneDisplay: async (id: string, d: { tokens?: Record<string, string | null> }) => {
        rec.push(`display ${id} ${JSON.stringify(d.tokens ?? {})}`);
      },
      notify: async (title: string) => void rec.push(`notify ${title}`),
      ...over,
    };
    return { config: { repoName: "demo" }, herdr, sleep: async () => {}, now: () => Math.floor(Date.now() / 1000), uid: () => "uid1", log: () => {} } as unknown as Deps;
  }

  const agentPane = (title: string, over: Partial<LayoutAgent> = {}): LayoutPane => ({
    title,
    persist: true,
    env: {},
    setup: false,
    agent: { kind: "claude", args: [], ...over },
  });

  it("builds each tab in ONE call: tab 0 rebuilds+relabels, later tabs are appended", async () => {
    const rec: string[] = [];
    const layout: LayoutConfig = {
      id: "web",
      tabs: [
        { title: "main", panes: [agentPane("agent"), { title: "editor", command: "nvim", persist: true, env: {}, setup: false, split: "right", size: { percent: 30 } }] },
        { title: "dev", panes: [{ title: "server", command: "pnpm dev", persist: true, env: {}, setup: false }] },
      ],
    };
    await applyLayout(stubDeps(rec), { workspaceId: "W", rootTabId: "T0", rootPaneId: "P0", cwd: "/work" }, layout);
    expect(rec).toEqual([
      // tab_id and workspace_id are mutually exclusive; tab_label names the tab either way, so there
      // is no follow-up `tab rename`. Commands ride IN the tree, so no `pane run` at all.
      "layoutApply tab=T0 ws= label=main",
      "layoutApply tab= ws=W label=dev",
      // Then the agents, after their pane is confirmed to be at a shell prompt.
      "agentAdopt t0a name=claude-w kind=claude args= timeout=60000",
    ]);
  });

  it("starts an agent pane's configured agent, with its args, name and timeout", async () => {
    const rec: string[] = [];
    await applyLayout(
      stubDeps(rec),
      { workspaceId: "W", rootTabId: "T0", cwd: "/work" },
      {
        id: "solo",
        tabs: [{ title: "main", panes: [agentPane("agent", { kind: "opencode", name: "rev-1", args: ["--yolo"], startTimeoutMs: 90_000 })] }],
      },
    );
    expect(rec).toContain("agentAdopt t0 name=rev-1 kind=opencode args=--yolo timeout=90000");
  });

  it("submits a pane's opening prompt, waiting only when a prompt timeout is configured", async () => {
    const rec: string[] = [];
    await applyLayout(
      stubDeps(rec),
      { workspaceId: "W", rootTabId: "T0" },
      { id: "p", tabs: [{ title: "t", panes: [agentPane("a", { prompt: "read TASK.md" })] }] },
    );
    expect(rec).toContain(`agentOpenPrompt t0 "read TASK.md" settle=`);

    const rec2: string[] = [];
    await applyLayout(
      stubDeps(rec2),
      { workspaceId: "W", rootTabId: "T0" },
      { id: "p", tabs: [{ title: "t", panes: [agentPane("a", { prompt: "go", promptTimeoutMs: 120_000 })] }] },
    );
    expect(rec2).toContain(`agentOpenPrompt t0 "go" settle=120000`);
  });

  it("a failed agent warns + notifies but leaves the built layout standing", async () => {
    const rec: string[] = [];
    const deps = stubDeps(rec, { agentAdopt: async () => false });
    await applyLayout(deps, { workspaceId: "W", rootTabId: "T0" }, { id: "p", tabs: [{ title: "t", panes: [agentPane("a")] }] });
    expect(rec).toContain("notify herdr-factory: agent did not start");
  });

  it("waits for the setup status file, reporting progress on the pane, before starting its agent", async () => {
    // Setup's completion is read from the status FILE its own script writes — no terminal scraping, so
    // it can't be missed because a marker scrolled away, wrapped, or was echoed by the shell early.
    const root = mkdtempSync(join(tmpdir(), "hf-state-"));
    tmps.push(root);
    process.env.HERDR_FACTORY_STATE_ROOT = root;
    // Stand in for the pane's script having finished: the status is already recorded when the runner
    // looks (`uid1` is the stubbed build token).
    const statusPath = join(root, "layout-hook", "setup", "uid1.status");
    mkdirSync(join(root, "layout-hook", "setup"), { recursive: true });
    writeFileSync(statusPath, "0");

    const rec: string[] = [];
    await applyLayout(
      stubDeps(rec),
      { workspaceId: "W", rootTabId: "T0" },
      { id: "p", setup: { command: "npm ci", blocking: false }, tabs: [{ title: "t", panes: [{ ...agentPane("a"), setup: true }] }] },
    );
    // The pane is flagged while setup runs, and the token is cleared once it exits 0 — and the agent
    // is only started after that (herdr can't start one in a pane that is still running a command).
    expect(rec).toContain(`display t0 {"hf_setup":"running"}`);
    expect(rec).toContain(`display t0 {"hf_setup":null}`);
    expect(rec.indexOf(`display t0 {"hf_setup":null}`)).toBeLessThan(rec.findIndex((r) => r.startsWith("agentAdopt")));
    expect(existsSync(statusPath)).toBe(false); // consumed, so a later build can't read a stale status
  });

  it("reports a failed setup on the pane and notifies, without failing the build", async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-state-"));
    tmps.push(root);
    process.env.HERDR_FACTORY_STATE_ROOT = root;
    mkdirSync(join(root, "layout-hook", "setup"), { recursive: true });
    writeFileSync(join(root, "layout-hook", "setup", "uid1.status"), "127");

    const rec: string[] = [];
    await applyLayout(
      stubDeps(rec),
      { workspaceId: "W", rootTabId: "T0" },
      { id: "p", setup: { command: "npm ci", blocking: true }, tabs: [{ title: "t", panes: [{ ...agentPane("a"), setup: true }] }] },
    );
    expect(rec).toContain(`display t0 {"hf_setup":"failed-127"}`);
    expect(rec).toContain("notify herdr-factory: layout setup failed");
    expect(rec.some((r) => r.startsWith("agentAdopt"))).toBe(true); // the layout still stands
  });

  it("fails loudly when herdr builds a different number of panes than planned", async () => {
    const rec: string[] = [];
    const deps = stubDeps(rec, { layoutApply: async () => ({ tabId: "TAB0", paneIds: ["only-one"] }) });
    const layout: LayoutConfig = { id: "web", tabs: [{ title: "t", panes: [agentPane("a"), agentPane("b")] }] };
    await expect(applyLayout(deps, { workspaceId: "W", rootTabId: "T0" }, layout)).rejects.toThrow(/built 1 panes for tab 0, expected 2/);
  });
});

describe("deriveAgentName — herdr's [a-z][a-z0-9_-]{0,31} rule", () => {
  it("builds a name from the kind + workspace, so two worktrees don't collide", () => {
    expect(deriveAgentName("claude", "w3G")).toBe("claude-w3g");
    expect(deriveAgentName("claude", "w5")).toBe("claude-w5");
  });
  it("strips anything herdr would reject and stays within 32 chars", () => {
    const name = deriveAgentName("opencode", "workspace:with/odd-chars-and-a-very-long-id");
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
});
