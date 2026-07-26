// The ask-human cord over a source whose reply channel is COMMENTS rather than a file. Two things
// are specific to that and cannot be tested with a markdown source:
//
//   * the question is posted as a comment on the ticket, carrying the engine's marker; and
//   * reply polling must ignore the factory's OWN marker-bearing comments (INV-6) — otherwise the
//     question it just posted reads as the answer and the run resumes with nonsense. The filter is
//     blockquote-aware, so a human who quote-replies still counts.
import { expect } from "vitest";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { scenario } from "../harness/index.ts";

const jira = new JiraFake({ project: "APP", boardId: 254 });

scenario(
  {
    name: "jira-ask-human",
    timeoutMs: 300_000,
    beforeStart: async () => {
      await jira.listen();
      jira.seed({ key: "APP-9", summary: "Ambiguous requirement", type: "Task", status: "To Do", labels: ["agent"] });
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    config: () => ({
      work_sources: [
        { type: "jira", name: "board", jira: { base_url: jira.url, project: "APP", board: 254, status: { todo: "To Do", in_development: "In Progress", review: "In Review" } } },
      ],
      belt: [{ name: "tickets", source: "board", label: "agent", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { steps: { work: { signal: "ask-human", text: "Should this apply to logged-out users too?" } } },
  },
  async (w) => {
    const key = "APP-9";

    await w.waitFor(() => w.db.run(key)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 240_000 });

    // The question went out as a comment on the ticket, marked as the factory's own.
    await w.waitFor(() => jira.comments(key).length > 0, { label: "the question is posted to Jira", timeoutMs: 60_000 });
    const asked = jira.comments(key)[0]!;
    expect(asked.body).toContain("Should this apply to logged-out users too?");
    expect(asked.body, "the engine marks what it wrote so it can ignore it later").toContain("[herdr-factory");

    // Give it a while to poll its own comment back — the marker filter is what must stop it.
    await w.waitFor(() => jira.requests("/comment").length > 1, { label: "the engine polls for a reply", timeoutMs: 90_000 });
    expect(w.db.run(key)!.phase, "the factory's own comment is not an answer").toBe("waiting_for_human");

    // ── a human replies, quoting the question ────────────────────────────────────────────────
    w.setAgentScript({ steps: { work: { signal: "step-done" } } });
    jira.addComment(key, "> Should this apply to logged-out users too?\n\nYes — logged-out too.", "a.human");
    w.db.dueNow("human_reply_poll", w.db.run(key)!.id);

    await w.waitFor(() => w.db.run(key)?.phase === "running", { label: "the human reply resumes the step", timeoutMs: 120_000 });
    expect(w.db.eventTypes(key)).toContain("human_reply");
    await w.waitForEnd(key, undefined, { label: "and the run finishes", timeoutMs: 120_000 });
  },
);
