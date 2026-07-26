// Throughput. The engine's scale claims are structural — parallel Phase A under per-run locks, claim
// admission smoothing a cold start, caps that bound work in flight — and none of them are visible at
// one run. This drains a backlog and checks the invariants that must hold at every moment of it:
//
//   * exactly ONE run per work item, however many passes race (the DB's partial unique index is the
//     arbiter, not a check-then-create in application code);
//   * the concurrency cap is never exceeded, sampled continuously rather than at the end; and
//   * per-tick admission means the backlog drains over several passes instead of 60 worktrees at once.
//
// Fake-herdr lane: 60 concurrent runs is 60 PTYs and 60 agent processes in the real lane, and none of
// what this measures is about terminals.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const COUNT = 60;
const CAP = 5; // the SOURCE's cap — the tighter of the two, so it is the one that binds
const REPO_CAP = 8; // the repo-wide ceiling above it
const ADMIT_PER_TICK = 10;

const briefs: Record<string, string> = {};
for (let i = 1; i <= COUNT; i++) briefs[`item-${String(i).padStart(2, "0")}`] = `# Item ${i}\n\nOne of ${COUNT}.\n`;

scenario(
  {
    name: "perf-scale-drain",
    lane: "fake",
    timeoutMs: 600_000,
    briefs,
    config: (p) => ({
      limits: { max_active_workspaces: REPO_CAP, max_claims_per_tick: ADMIT_PER_TICK, reconcile_concurrency: 8, tick_interval_seconds: 1 },
      // Concurrency is capped at TWO levels and the tighter one wins. Setting only the repo-wide limit
      // is the trap: a source's own `max_active_workspaces` defaults to 2, so the first version of this
      // scenario asked for 5 and drained the whole backlog two runs at a time, with the repo cap never
      // even logging "at capacity". Both are set here, and the assertions below pin which one binds.
      work_sources: [{ type: "local_markdown", name: "briefs", max_active_workspaces: CAP, local_markdown: { folder: p.briefs } }],
      belt: [{ name: "drain", source: "briefs", workspace_name: "d/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { default: { workMs: 0 } },
  },
  async (w) => {
    const keys = Object.keys(briefs);
    const started = Date.now();
    let peak = 0;
    let samples = 0;

    await w.waitFor(
      () => {
        const occupying = w.db.activeRuns().filter((r) => r.phase !== "attention" && r.phase !== "waiting_for_human").length;
        peak = Math.max(peak, occupying);
        samples++;
        return keys.every((k) => w.db.run(k)?.ended_at != null);
      },
      { label: `all ${COUNT} items drain`, timeoutMs: 540_000, pollMs: 200 },
    );

    const elapsedMs = Date.now() - started;
    const runs = w.db.runs();

    // One run per item — no double-claim, however many passes were in flight.
    expect(runs.length, "exactly one run per work item").toBe(COUNT);
    expect(new Set(runs.map((r) => r.ticket_key)).size).toBe(COUNT);
    // …and every one of them actually finished, not just stopped being active.
    expect(runs.filter((r) => r.outcome === "completed").length).toBe(COUNT);

    // The SOURCE cap is the binding one — never exceeded, and actually reached, so the drain really did
    // run saturated rather than trickling (a trickle would satisfy any ≤ assertion without meaning it).
    expect(peak, `the source cap of ${CAP} was never exceeded (${samples} samples)`).toBeLessThanOrEqual(CAP);
    expect(peak, `the source cap of ${CAP} was reached, so the backlog drained saturated`).toBe(CAP);

    // Every item's branch is distinct: the per-run uid means a re-claim can never collide either.
    expect(new Set(runs.map((r) => r.branch)).size, "distinct branches").toBe(COUNT);

    w.recordMetrics({
      items: COUNT,
      cap: CAP,
      peakOccupying: peak,
      elapsedMs,
      msPerItem: Math.round(elapsedMs / COUNT),
      ...w.sample(),
    });
    // A generous ceiling: this is a regression tripwire for something going quadratic, not a benchmark.
    expect(elapsedMs, `draining ${COUNT} items took ${Math.round(elapsedMs / 1000)}s`).toBeLessThan(480_000);
  },
);
