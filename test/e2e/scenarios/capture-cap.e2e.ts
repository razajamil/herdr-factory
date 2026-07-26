// A flaky app can keep an evidence agent re-capturing forever, so capture attempts are counted and
// the run parks past the cap. The subtle half — and the reason this scenario exists — is that the cap
// is a BACKSTOP against a stuck agent, never a veto on its verdict: if the parked step then reaches a
// genuine terminal, the run follows it. Evidence is non-gating, pass or fail.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

scenario(
  {
    name: "capture-cap",
    timeoutMs: 240_000,
    briefs: { "flaky-capture": "# Flaky capture\n\n## Acceptance criteria\n- the page renders\n" },
    config: (p) => ({
      limits: { max_capture_attempts: 1 },
      evidence: { publisher: "local", key_prefix: "e2e", github_username: "harness" },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [
        {
          id: "with-evidence",
          // See evidence.e2e.ts: every step needs a layout pane, or the first dedicated spawn races
          // the hook's fresh-worktree guard and the layout is never built.
          tabs: [
            { title: "work", panes: [{ title: "agent", agent: "claude" }] },
            { title: "evidence", panes: [{ title: "agent", agent: "claude" }] },
            { title: "review", panes: [{ title: "agent", agent: "claude" }] },
          ],
        },
      ],
      belt: [
        {
          name: "proving",
          source: "briefs",
          workspace_name: "c/{{work_id}}",
          default_layout: "with-evidence",
          steps: [
            { type: "work", tab: "work", pane: "agent" },
            { type: "evidence", tab: "evidence", pane: "agent" },
            { type: "review", tab: "review", pane: "agent" },
          ],
        },
      ],
    }),
    // Three capture attempts against a cap of one, and then a real verdict.
    agent: { steps: { evidence: { commit: false, captureAttempts: 3, evidence: true }, review: { commit: false } } },
  },
  async (w) => {
    const key = "flaky-capture";

    await w.waitForEvent(key, "attention", { label: "the capture cap parks the flaky station", timeoutMs: 150_000 });
    const parked = w.db.event(key, "attention", "first")!;
    expect(parked.data.reason).toBe("capture_limit");
    expect(w.db.events(key).filter((e) => e.type === "capture_attempt").length, "each attempt was counted").toBeGreaterThan(1);

    // …and the agent's own verdict still wins: its step-done un-parks the run and advances the belt.
    await w.waitForEnd(key, "completed", { label: "a genuine terminal from the parked step is honoured", timeoutMs: 180_000 });
    const resumed = w.db.event(key, "resumed");
    expect(resumed?.data.reason, "un-parked by the step's own completion, not by a human").toBe("step_done_after_watchdog_park");
    expect(w.db.run(key)!.attention_reason).toBeNull();
  },
);
