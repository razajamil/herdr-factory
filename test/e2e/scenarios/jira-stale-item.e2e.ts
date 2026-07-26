// A work item can vanish under a running factory: deleted, moved to a project the token can't see, or
// its permissions revoked. That is not a transient failure — retrying can never fix it — so the source
// answers `stale`, and the engine handles it in TWO PHASES: the lock-free outbox flush only marks the
// intent delivered and stamps it, and the run-locked pass consumes that exactly once. Which way it
// goes depends on how far the run had got:
//
//   * `in_development` stale — the claim write-back found the ticket gone, i.e. "don't do this work" —
//     aborts the run promptly; while
//   * a mid-flight stale parks it for a human, with NO note posted (the place the note would go is
//     what's gone).
//
// This pins the first half, and that a deleted ticket does not become an infinite retry loop.
import { expect } from "vitest";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { scenario } from "../harness/index.ts";

const jira = new JiraFake({ project: "APP", boardId: 254 });

scenario(
  {
    name: "jira-stale-item",
    timeoutMs: 240_000,
    beforeStart: async () => {
      await jira.listen();
      jira.seed({ key: "APP-5", summary: "Will be deleted", type: "Task", status: "To Do", labels: ["agent"] });
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    config: () => ({
      work_sources: [
        { type: "jira", name: "board", jira: { base_url: jira.url, project: "APP", board: 254, status: { todo: "To Do", in_development: "In Progress", review: "In Review" } } },
      ],
      belt: [{ name: "tickets", source: "board", label: "agent", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    // The agent never signals: the run stays put so the vanishing ticket is what moves it, not progress.
    agent: { steps: { work: { signal: "none" } } },
  },
  async (w) => {
    const key = "APP-5";

    // Let the claim land first — the run has to exist for the write-back to find the ticket gone.
    await w.waitFor(() => w.db.run(key)?.workspace_id != null, { label: "the ticket is claimed", timeoutMs: 180_000 });

    // …and now it disappears from Jira entirely.
    jira.gone.add(key);
    // The claim's own `in_development` write-back may already have landed; force another transition
    // attempt by making the run's outbox rows due now.
    const runId = w.db.run(key)!.id;
    w.db.dueNow("source_transition", runId);

    await w.waitForEvent(key, "stale", { label: "the source reports the item as gone", timeoutMs: 120_000 });

    // Delivered, not retried forever: no transition intent is left pending against a ticket that
    // cannot answer.
    await w.waitFor(() => w.db.intents({ kind: "source_transition", runId }).every((i) => i.status !== "pending" || i.error_class === null), {
      label: "the transition is not left retrying against a 404",
      timeoutMs: 60_000,
    });
    const attempts = w.db.intents({ kind: "source_transition", runId });
    expect(attempts.some((i) => i.status === "delivered"), "a stale transition counts as delivered").toBe(true);

    // The run doesn't sit there pretending: it ends (aborted) or parks for a human, and either way it
    // stops holding a claim slot for work nobody wants.
    await w.waitFor(() => {
      const r = w.db.run(key)!;
      return r.ended_at != null || r.phase === "attention";
    }, { label: "the run is aborted or parked, not left running", timeoutMs: 120_000 });
    const run = w.db.run(key)!;
    expect(run.ended_at != null || run.phase === "attention").toBe(true);
    if (run.ended_at != null) expect(run.outcome, "a pre-work stale aborts the run").toBe("abandoned");
  },
);
