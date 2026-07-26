// The external-call budget. Watching N pull requests must cost ONE GitHub query per tick, not three
// per PR: at 50 reviewing runs the per-run form was ~9k requests/hour, over the REST budget on its
// own. That is why `prSnapshots` exists (one aliased GraphQL query, chunked at 25) and why its
// signature hash is bit-identical to the per-run one — so the two can mix without re-waking resolvers.
//
// A budget is the kind of property that decays silently: nothing breaks when a well-meaning change
// adds a per-run call, it just costs money and rate limit. So this counts real invocations of the `gh`
// shim over an exact number of ticks, which is deterministic in a way wall-clock timing is not.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const COUNT = 12;
const TICKS = 5;

const briefs: Record<string, string> = {};
for (let i = 1; i <= COUNT; i++) briefs[`pr-${String(i).padStart(2, "0")}`] = `# PR ${i}\n\nOne of ${COUNT} watched PRs.\n`;

scenario(
  {
    name: "perf-call-budgets",
    lane: "fake",
    timeoutMs: 600_000,
    briefs,
    config: (p) => ({
      // The server is up (so RSS/FDs/health are measurable and `viaServerOrLocal` takes its real
      // path) but does NOT tick itself: every pass in this scenario is one the harness drove, which
      // is what makes a per-pass budget/latency number mean anything. The source is still polled on
      // each of those passes (a poll interval below the tick interval disengages the poll gate).
      limits: { tick_interval_seconds: 3600, source_poll_interval_seconds: 1, max_active_workspaces: COUNT, max_claims_per_tick: COUNT },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "watching", source: "briefs", workspace_name: "w/{{work_id}}", steps: [{ type: "work" }, { type: "pr" }] }],
    }),
    agent: { default: { workMs: 0 } },
  },
  async (w) => {
    const keys = Object.keys(briefs);

    // Get every run into the review watch: PR open, non-draft, nobody merging it.
    await w.waitFor(() => keys.every((k) => w.db.run(k)?.phase === "reviewing"), {
      label: `all ${COUNT} runs reach the PR watch`,
      timeoutMs: 540_000,
      tickEveryMs: 300,
    });

    // ── measure ───────────────────────────────────────────────────────────────────────────────
    w.gh.reset();
    for (let i = 0; i < TICKS; i++) await w.tick();

    const calls = w.gh.calls();
    const graphql = calls.filter((c) => c.subcommand === "api graphql").length;
    const prView = calls.filter((c) => c.subcommand === "pr view").length;
    const prList = calls.filter((c) => c.subcommand === "pr list").length;

    w.recordMetrics({ watchedPrs: COUNT, ticks: TICKS, graphql, prView, prList, totalGhCalls: calls.length });

    // ONE batched query per tick covers every watched PR — the whole point of prSnapshots.
    expect(graphql, `${graphql} graphql calls for ${COUNT} PRs over ${TICKS} ticks`).toBeLessThanOrEqual(TICKS);
    expect(graphql, "…and the batch really is being used").toBeGreaterThan(0);

    // No per-run polling behind it: `pr view` is the fallback for a nudge or a failed batch only.
    expect(prView, "the batch replaced per-run pr view polling").toBe(0);
    // And nothing re-discovers PRs it already knows by number.
    expect(prList, "a PR is discovered once, then followed by number").toBe(0);

    // The total cost of watching does not scale with the number of PRs.
    expect(calls.length, `${calls.length} gh calls total for ${COUNT} PRs over ${TICKS} ticks`).toBeLessThanOrEqual(TICKS * 2);
  },
);
