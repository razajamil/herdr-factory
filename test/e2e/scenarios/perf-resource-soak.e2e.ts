// The resident server runs for weeks. Anything it accumulates per tick — a leaked handle, a growing
// in-memory map, an unclosed statement, an ever-growing table — is invisible in a 20-second test and
// fatal in production. This ticks a small workload for a long time and watches what the process holds.
//
// It asserts SHAPE, not absolute numbers: RSS and FD counts differ per machine, but "flat after warmup"
// is the property, and that is what regresses when something starts accumulating.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

// A fake-lane pass costs ~100ms, so the tick COUNT is what makes this a soak (~90s of continuous
// reconciling) rather than a blink. The first ~15s of it runs the real workload — six items claimed,
// worked, finished and torn down, two at a time — and the long tail after that measures the shape the
// server actually spends its life in: an idle tick loop with nothing to claim.
const TICKS = 900;
const SAMPLE_EVERY = 60;
const CYCLE = 6; // items claimed, finished and torn down

const briefs: Record<string, string> = {};
for (let i = 1; i <= CYCLE; i++) briefs[`soak-${i}`] = `# Soak ${i}\n\nRun, finish, be torn down.\n`;

scenario(
  {
    name: "perf-resource-soak",
    lane: "fake",
    timeoutMs: 900_000,
    briefs,
    config: (p) => ({
      // The server is up (so RSS/FDs/health are measurable and `viaServerOrLocal` takes its real
      // path) but does NOT tick itself: every pass in this scenario is one the harness drove, which
      // is what makes a per-pass budget/latency number mean anything. The source is still polled on
      // each of those passes (a poll interval below the tick interval disengages the poll gate).
      limits: { tick_interval_seconds: 3600, source_poll_interval_seconds: 1, max_active_workspaces: 3 },
      // Both caps, deliberately equal: a source's own cap defaults to 2 and would otherwise be the one
      // that binds (see perf-scale-drain).
      work_sources: [{ type: "local_markdown", name: "briefs", max_active_workspaces: 3, local_markdown: { folder: p.briefs } }],
      belt: [{ name: "soak", source: "briefs", workspace_name: "s/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { default: { workMs: 0 } },
  },
  async (w) => {
    // Let the workload settle first: the first passes legitimately allocate (DB pages, clients, the
    // Effect runtime), so a baseline taken at tick 0 would measure startup, not a leak.
    for (let i = 0; i < 20; i++) await w.tick();
    const baseline = w.sample();

    const samples: { tick: number; rssKb: number; fds: number; dbBytes: number; worktrees: number }[] = [];
    for (let i = 1; i <= TICKS; i++) {
      await w.tick();
      if (i % SAMPLE_EVERY === 0) samples.push({ tick: i, ...w.sample() });
    }
    const last = samples[samples.length - 1]!;
    const peakFds = Math.max(...samples.map((s) => s.fds));
    const peakRss = Math.max(...samples.map((s) => s.rssKb));

    w.recordMetrics({
      ticks: TICKS,
      baselineRssKb: baseline.rssKb,
      finalRssKb: last.rssKb,
      peakRssKb: peakRss,
      rssGrowthPct: baseline.rssKb ? Math.round(((last.rssKb - baseline.rssKb) / baseline.rssKb) * 100) : 0,
      baselineFds: baseline.fds,
      finalFds: last.fds,
      peakFds,
      dbGrowthBytes: last.dbBytes - baseline.dbBytes,
      worktrees: last.worktrees,
    });

    // Memory: some growth is normal (V8 heap slack, SQLite page cache); doubling over ~900 passes is not.
    expect(last.rssKb, `RSS grew from ${baseline.rssKb}KB to ${last.rssKb}KB over ${TICKS} passes`).toBeLessThan(baseline.rssKb * 2);
    // File descriptors are the sharpest leak signal: every tick opens subprocesses and (for the real
    // lane) sockets, and a handle that is never closed shows up here first. Assert only when the count
    // is real — a machine with neither procfs nor lsof would otherwise "pass" 0 < 60 forever.
    expect(baseline.fds, "the harness could not count open FDs — the leak check would be vacuous").toBeGreaterThan(0);
    expect(peakFds, `open FDs went from ${baseline.fds} to a peak of ${peakFds}`).toBeLessThan(baseline.fds + 60);
    expect(baseline.rssKb, "the harness could not read RSS — the memory check would be vacuous").toBeGreaterThan(0);

    // Worktrees are reaped as runs end — the main checkout plus at most the cap should remain.
    expect(last.worktrees, "worktrees are torn down, not accumulated").toBeLessThanOrEqual(1 + 3);

    // And the thing itself is still healthy and doing work at the end.
    expect(await w.factory.health(), "the server is still up after the soak").toBeTruthy();
    expect(w.db.runs().filter((r) => r.outcome === "completed").length, "work really was completing throughout").toBeGreaterThanOrEqual(CYCLE);
  },
);
