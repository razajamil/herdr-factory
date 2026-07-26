// Regression test for a bug this suite found: a layout pane that is BOTH the setup pane and an agent
// pane used to never get an agent, so every step targeting it burned the layout wait and the run
// parked `layout_wait_timeout`. The shipped README's canonical layout is exactly this shape.
//
// Cause: `paneScript` baked the setup command into the pane's own process, ending it with
// `HAND_BACK = exec $SHELL -i`; herdr 0.7.5 accepts `agent start` against that re-exec'd shell and
// then launches nothing (`agent.get` times out after 60s — `pane process-info` showed the pane's
// process replaced by a non-login `/bin/bash -i`, where a working agent pane shows the agent as a
// child of herdr's own shell).
//
// Fix: an agent pane is handed to herdr as a plain shell, and the layout's setup command is RUN in it
// with `pane run` once it exists — what a human would do, and it leaves herdr's shell in place.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { expectStepDone, scenario } from "../harness/index.ts";

scenario(
  {
    name: "layout-setup-on-agent-pane",
    timeoutMs: 240_000,
    briefs: { "setup-pane": "# Setup pane\n\nWork on a pane that also runs the layout's setup.\n" },
    repoFiles: { "scripts/setup.sh": '#!/bin/sh\necho ok > "$HOME/setup-ran"\n' },
    config: (p) => ({
      limits: { layout_wait_seconds: 20 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [
        {
          id: "setup-on-agent",
          setup: { command: "./scripts/setup.sh", blocking: true },
          tabs: [{ title: "work", panes: [{ title: "agent", agent: "claude", setup: true }] }],
        },
      ],
      belt: [
        {
          name: "layout-belt",
          source: "briefs",
          workspace_name: "sp/{{work_id}}",
          default_layout: "setup-on-agent",
          steps: [{ type: "work", tab: "work", pane: "agent" }],
        },
      ],
    }),
  },
  async (w) => {
    const key = "setup-pane";

    await w.waitForEvent(key, "layout_applied", { label: "the layout is built", timeoutMs: 120_000 });
    const ws = w.db.run(key)!.workspace_id!;
    expect(w.herdr.paneLabels(ws)).toEqual(["work/agent"]);

    // The setup command still ran — it is executed IN the pane rather than as the pane's process.
    expect(existsSync(join(w.paths.home, "setup-ran")), "the blocking setup command ran").toBe(true);

    // …and the pane is still adoptable, which is the whole point.
    await w.waitFor(() => w.herdr.agents().some((a) => a.workspace_id === ws && a.agent_status !== "gone"), {
      label: "herdr adopts an agent into the setup pane",
      timeoutMs: 120_000,
    });
    expect(w.factory.repoLog(400), "no failed adoption").not.toContain("could not start");

    await w.waitForEnd(key, "completed", { label: "the step runs to completion in the setup pane", timeoutMs: 180_000 });
    expectStepDone(w, key, ["work"]);
    expect(w.db.events(key).filter((e) => e.type === "layout_wait_retry"), "the layout wait is never re-armed").toEqual([]);
    expect(w.db.run(key)!.attention_reason_code, "and the run never parks").toBeNull();
  },
);
