// "herdr unreachable ≠ pane dead" — the invariant that exists because breaking it is a feedback loop:
// one herdr hiccup looked like mass pane death, every run respawned an agent into a worktree whose
// original agent was still working, the duplicate agents added load, and the load caused more hiccups.
//
// So liveness must never act on uncertainty. Two rules, both asserted here:
//   * while herdr can't be queried, the watchdog and the dead-pane check DEFER (never park, never
//     respawn); and
//   * once it answers again, a deferred window is not forgiven — it is judged, and a live `working`
//     agent vetoes the timer rather than being parked by it.
//
// The outage is injected in the world's herdr wrapper, so this runs against the REAL server: the
// factory's calls start failing exactly the way they do with no server listening (which is all
// `HerdrUnreachableError` is), while the panes stay alive and the harness stays able to see them. A
// killed server would instead be a CONFIRMED-gone pane — a different failure, and one that makes the
// defer-vs-park distinction untestable.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const WORK_MS = 30_000;
const BUDGET_S = 20;

scenario(
  {
    name: "herdr-unreachable",
    timeoutMs: 300_000,
    briefs: { "keep-calm": "# Keep calm\n\nherdr is about to stop answering.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      // The budget expires DURING the outage, so the watchdog is forced to reach a verdict on a run
      // it cannot see. Long enough (20s) that herdr has had time to observe the agent as `working`
      // before it trips — with a 5s budget the trip beats the agent's first status report, and the
      // scenario would be asserting against an agent that genuinely was idle.
      belt: [{ name: "calm", source: "briefs", workspace_name: "c/{{work_id}}", steps: [{ type: "work", budget_seconds: BUDGET_S }] }],
    }),
    // An agent that reports `working` for 30s and then really finishes: the one a false "gone" would
    // have duplicated, the one whose status must veto the expired budget once herdr can be asked
    // again — and, because it goes on to signal, proof that the outage left no residue. (`hangMs`
    // would never signal at all, so it could not show that last part.)
    agent: { steps: { work: { preWorkMs: WORK_MS, status: "working" } } },
  },
  async (w) => {
    const key = "keep-calm";

    await w.waitFor(() => w.db.step(w.db.run(key)?.id ?? -1, "work")?.pane_id != null, { label: "the work agent is dispatched", timeoutMs: 120_000 });
    const run = w.db.run(key)!;
    const pane = w.db.step(run.id, "work")!.pane_id!;
    const spawnsBefore = w.db.events(key).filter((e) => e.type === "step_spawned").length;

    // ── herdr stops answering ─────────────────────────────────────────────────────────────────
    w.herdr.unreachable = true;

    // Hold the outage until the BUDGET itself has tripped and been deferred ("watchdog deferred" is
    // the veto path: the window expired, and the engine could not ask who was working). Waiting for
    // any "deferred" line would pass on the dead-pane check alone — which fires within a second of
    // the injection and proves nothing about the timer that actually parks runs.
    await w.waitFor(() => /watchdog deferred/.test(w.factory.repoLog(600)), {
      label: `the expired ${BUDGET_S}s budget is deferred, not judged, while herdr cannot be asked`,
      timeoutMs: 120_000,
    });

    // The budget is now expired and stays expired, pass after pass, with no verdict reached.
    expect(w.db.run(key)!.phase, "an unreachable herdr must not park a healthy run").toBe("running");
    expect(w.db.run(key)!.attention_reason_code).toBeNull();
    expect(
      w.db.events(key).filter((e) => e.type === "step_spawned").length,
      "and must never respawn a second agent into a worktree whose agent is still working",
    ).toBe(spawnsBefore);
    expect(w.db.step(run.id, "work")!.pane_id, "the recorded pane is untouched").toBe(pane);

    // ── herdr comes back ──────────────────────────────────────────────────────────────────────
    w.herdr.unreachable = false;

    // The budget really had expired, so now that liveness CAN be judged it is: the working agent's
    // status is what saves the run, not the deferral. Defer buys time; it does not forgive.
    await w.waitFor(() => /still working — extending/.test(w.factory.repoLog(400)), {
      label: "the expired budget is judged once herdr answers, and the live agent vetoes it",
      timeoutMs: 120_000,
    });
    expect(w.db.run(key)!.phase, "a working agent is never parked by a timer").toBe("running");

    // And nothing about the outage left residue: the agent finishes and the run completes normally.
    await w.waitForEnd(key, "completed", { timeoutMs: WORK_MS + 90_000 });
    expect(w.db.events(key).filter((e) => e.type === "step_spawned").length, "exactly one agent ever ran this step").toBe(spawnsBefore);
  },
);
