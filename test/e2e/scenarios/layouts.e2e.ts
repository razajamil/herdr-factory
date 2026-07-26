// Layouts: the factory-as-herdr-plugin path. On `worktree.created` the hook matches the new worktree
// to a repo config, picks the belt's layout, and builds it with ONE `layout.apply` per tab (splits,
// sizes, labels, cwd, env) plus the setup command and each pane's agent. Steps then dispatch INTO
// those panes instead of spawning their own.
//
// Both entry points are covered: a worktree the FACTORY created by claiming work, and one created by
// HAND (no owning run — the hook resolves the layout by walking the repo's belts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { expectStepDone, expectTimeline, scenario } from "../harness/index.ts";

scenario(
  {
    name: "layouts",
    briefs: { "layout-item": "# Layout item\n\nDo the thing.\n" },
    repoFiles: {
      "scripts/setup.sh": '#!/bin/sh\necho ok > "$HOME/setup-ran"\n',
    },
    config: (p) => ({
      limits: { layout_wait_seconds: 30 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [
        {
          id: "app-dev",
          // blocking: the runner waits for this to finish before any other pane's command or agent.
          setup: { command: "./scripts/setup.sh", blocking: true },
          tabs: [
            {
              title: "work",
              panes: [
                { title: "agent", agent: "claude", agent_args: ["--dangerously-skip-permissions"] },
                // percent (not cells): a headless tab measures ~54x23, so ratios travel and cell
                // counts do not.
                // `setup: true` lives on the COMMAND pane, not the agent pane: an agent pane that
                // also runs the setup command gets `exec $SHELL -i` appended (layout.ts HAND_BACK)
                // and herdr then never adopts an agent into it — see the
                // `layout-setup-on-agent-pane` scenario, which pins that behaviour.
                { title: "logs", command: "tail -f /dev/null", split: "right", size: "40%", setup: true },
              ],
            },
            { title: "review", panes: [{ title: "agent", agent: "claude" }] },
          ],
        },
        { id: "app-dev-hotfix", tabs: [{ title: "work", panes: [{ title: "agent", agent: "claude" }] }] },
      ],
      belt: [
        {
          name: "layout-belt",
          source: "briefs",
          workspace_name: "lay/{{work_id}}",
          default_layout: "app-dev",
          // No branch here matches, so the default layout wins — but the rule must still resolve at
          // config-load, which is half of what this asserts.
          layout_matching: [{ worktree_pattern: "hotfix/*", layout: "app-dev-hotfix" }],
          steps: [
            { type: "work", tab: "work", pane: "agent" },
            { type: "review", tab: "review", pane: "agent" },
          ],
        },
      ],
    }),
    agent: { steps: { review: { commit: false } } },
    timeoutMs: 240_000,
  },
  async (w) => {
    const key = "layout-item";

    // ── the factory-created worktree ───────────────────────────────────────────────────────────
    await w.waitForEvent(key, "layout_applied", { label: "the plugin hook builds the belt's layout", timeoutMs: 120_000 });
    const applied = w.db.event(key, "layout_applied")!;
    expect(applied.data.layout).toBe("app-dev");

    const run = w.db.run(key)!;
    const ws = run.workspace_id!;
    expect(w.herdr.paneLabels(ws), "the whole tab/pane tree from one layout.apply per tab").toEqual([
      "review/agent",
      "work/agent",
      "work/logs",
    ]);
    expect(existsSync(join(w.paths.home, "setup-ran")), "the blocking setup command ran").toBe(true);

    // Every pane the layout declared as an agent pane really has one herdr is tracking.
    await w.waitFor(() => w.herdr.agents().filter((a) => a.workspace_id === ws).length >= 2, {
      label: "both layout agent panes have a live agent",
    });

    // ── steps dispatch INTO the layout's panes (never spawning their own) ──────────────────────
    await w.waitFor(() => (w.db.step(run.id, "work")?.pane_id ?? null) !== null, { label: "the work step is dispatched" });
    const workPane = w.db.step(run.id, "work")!.pane_id!;
    const panes = w.herdr.panes(ws);
    const tabs = new Map(w.herdr.tabs(ws).map((t) => [t.tab_id, t.label]));
    const target = panes.find((p) => p.pane_id === workPane)!;
    expect(target, `pane ${workPane} belongs to this workspace`).toBeTruthy();
    expect(`${tabs.get(target.tab_id)}/${target.label}`, "work step landed on work/agent").toBe("work/agent");
    expect(w.factory.repoLog(200), "the engine says it dispatched to a layout pane").toContain("dispatched to layout pane");

    await w.waitForEnd(key, "completed", { label: "both layout-pane steps finish", timeoutMs: 180_000 });
    expectStepDone(w, key, ["work", "review"]);
    // The step flow and the layout build are concurrent — the hook fires on herdr's worktree.created
    // and finishes the second tab's agent while the first step is already working — so `layout_applied`
    // is asserted on its own (above) rather than pinned into this order.
    expectTimeline(w, key, ["claimed", "worktree_created", "step_spawned", "step_done", "step_spawned", "step_done", "torn_down"]);

    // The pane's REAL label is never renamed to convey run state — a step's `pane:` target has to keep
    // resolving for the pane's whole life; run state rides on display metadata instead.
    const meta = w.herdr.paneMetadata().filter((m) => m.paneId === workPane);
    expect(meta.length, "the engine published pane display metadata").toBeGreaterThan(0);
    expect(meta.some((m) => m.argv.join(" ").includes(`hf_key=${key}`)), "hf_key token published").toBe(true);

    // ── a HAND-created worktree gets a layout too (no owning run) ──────────────────────────────
    const manual = w.herdr.worktreeCreate(w.paths.repo, "manual/spike");
    expect(manual, "herdr created the manual worktree").toBeTruthy();
    const built = ["review/agent", "work/agent", "work/logs"];
    // Wait for the WHOLE layout, not just its first pane: the hook applies tab 0, then tab 1, then
    // starts each tab's agent, so a wait that stops at `work/agent` asserts the pane list mid-build.
    await w.waitFor(() => built.every((l) => w.herdr.paneLabels(manual!.workspaceId).includes(l)), {
      label: "the hook builds a layout into a hand-created worktree",
      timeoutMs: 120_000,
    });
    expect(w.herdr.paneLabels(manual!.workspaceId)).toEqual(built);
    expect(w.herdr.pluginLog(), "the plugin log records the build").toMatch(/app-dev|applied/i);
  },
);
