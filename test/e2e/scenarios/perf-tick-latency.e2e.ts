// Tick latency under load, and the property that makes it bounded at all: every external call is
// hard-timeout-bounded, so a pass is finite by construction and one hung subprocess cannot wedge the
// loop. (The wedged-tick watchdog behind it all is the backstop, not the mechanism.)
//
// Two things measured here: the p95 of a full pass with a load of active runs, and that a slow `gh`
// costs its own call rather than the whole tick's other work.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const COUNT = 20;
const MEASURED_TICKS = 12;

const briefs: Record<string, string> = {};
for (let i = 1; i <= COUNT; i++) briefs[`load-${String(i).padStart(2, "0")}`] = `# Load ${i}\n\nOne of ${COUNT}.\n`;

const percentile = (xs: number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

scenario(
  {
    name: "perf-tick-latency",
    lane: "fake",
    timeoutMs: 600_000,
    briefs,
    config: (p) => ({
      // The server is up (so RSS/FDs/health are measurable and `viaServerOrLocal` takes its real
      // path) but does NOT tick itself: every pass in this scenario is one the harness drove, which
      // is what makes a per-pass budget/latency number mean anything. The source is still polled on
      // each of those passes (a poll interval below the tick interval disengages the poll gate).
      limits: { tick_interval_seconds: 3600, source_poll_interval_seconds: 1, max_active_workspaces: COUNT, max_claims_per_tick: COUNT, reconcile_concurrency: 8 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "load", source: "briefs", workspace_name: "l/{{work_id}}", steps: [{ type: "work" }, { type: "pr" }] }],
    }),
    agent: { default: { workMs: 0 } },
  },
  async (w) => {
    const keys = Object.keys(briefs);

    // Load: every run parked in the review watch, so each pass has real per-run work to do.
    await w.waitFor(() => keys.every((k) => w.db.run(k)?.phase === "reviewing"), {
      label: `${COUNT} runs reach the PR watch`,
      timeoutMs: 480_000,
      tickEveryMs: 300,
    });

    const durations: number[] = [];
    for (let i = 0; i < MEASURED_TICKS; i++) durations.push(await w.factory.tickTimed());

    // ── one slow external call ────────────────────────────────────────────────────────────────
    // 3s inside `gh`, well under the engine's 60s hard cap. The pass must still return, and the
    // ticks after it must be normal again — a hung call may cost its own latency, never the loop.
    w.gh.inject({ sleepMs: 3000 });
    const slow = await w.factory.tickTimed();
    w.gh.inject(null);
    const after = await w.factory.tickTimed();

    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    w.recordMetrics({ activeRuns: COUNT, measuredTicks: MEASURED_TICKS, p50Ms: p50, p95Ms: p95, maxMs: Math.max(...durations), slowGhTickMs: slow, tickAfterSlowMs: after, ...w.sample() });

    // Generous ceilings: tripwires for a pass that started doing per-run work it used to batch, not a
    // benchmark of this machine.
    expect(p50, `p50 tick with ${COUNT} watched runs was ${p50}ms`).toBeLessThan(5_000);
    expect(p95, `p95 tick with ${COUNT} watched runs was ${p95}ms`).toBeLessThan(10_000);
    expect(after, "the pass after a slow external call is normal again").toBeLessThan(10_000);

    // Nothing was parked or lost while we hammered it.
    expect(w.db.activeRuns().filter((r) => r.phase === "attention"), "no run was parked by the load").toEqual([]);
    expect(w.db.activeRuns().length).toBe(COUNT);
  },
);
