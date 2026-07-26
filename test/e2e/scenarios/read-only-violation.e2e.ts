// `review` is a gate, not a workstation: it must not edit or commit, and the engine ENFORCES that by
// watching the branch HEAD across the step. This pins both halves of the design:
//
//   * the violation is detected and parked, with the reason a human can act on; and
//   * the park is a BACKSTOP, not a veto — a gate that nonetheless reached a genuine terminal
//     (step-done) un-parks and advances, clearing the enforcement baseline (RWR-18204). The engine
//     never throws away a completed verdict because the agent misbehaved on the way to it.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

scenario(
  {
    name: "read-only-violation",
    briefs: { "committing-gate": "# Committing gate\n\nThe review step will touch the tree.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "gated", source: "briefs", workspace_name: "g/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    // The review agent commits — the thing a read-only step may never do — and then signals done.
    // The dwell is what makes this deterministic: the baseline TRACKS HEAD (deliberately, so a prior
    // step's trailing commit cannot false-park the gate) and freezes only on a pass that OBSERVES
    // this agent working. That observation comes from the ~5s-memoized agent list, so the dwell has
    // to outlast the memo plus a tick — a real agent works for minutes; one that commits inside the
    // first few seconds is genuinely not caught, which is the documented cost of not re-polling
    // herdr per run per tick.
    agent: { steps: { review: { preWorkMs: 8000, commit: true, signal: "step-done" } } },
  },
  async (w) => {
    const key = "committing-gate";

    // The park is transient here (the completed step is rescued on the next pass), so assert on the
    // durable event rather than on catching the phase mid-flight.
    await w.waitForEvent(key, "attention", { label: "the read-only violation is caught", timeoutMs: 90_000 });
    const parked = w.db.event(key, "attention", "first")!;
    expect(parked.data.reason, "parked for the right reason").toBe("read_only_violation");

    await w.waitForEnd(key, "completed", { label: "the completed gate is still honoured", timeoutMs: 120_000 });

    // Rescued by its own step-done, not by a human: the resume event says so.
    const resumed = w.db.event(key, "resumed")!;
    expect(resumed.data.reason).toBe("step_done_after_watchdog_park");
    // The violation is recorded with its evidence, and the run is no longer parked (the reason CODE
    // is kept as the last-park record; the human-readable reason is what gets cleared).
    expect(parked.data.baseline, "the park names the baseline it enforced").toBeTruthy();
    expect(parked.data.head).not.toBe(parked.data.baseline);
    expect(w.db.run(key)!.attention_reason).toBeNull();
    // (The offending commit itself is gone by now — teardown deletes the branch — which is why the
    // park event records the two shas: they are the durable evidence that HEAD moved under the gate.)
  },
);
