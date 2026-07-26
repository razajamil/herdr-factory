// The ask-human cord. A blocked agent must be able to stop and ask, and the factory has to carry the
// question out through the work source, hold the run without holding a CONCURRENCY SLOT, notice the
// answer, put it where the agent will read it, and resume the same step — the same pass, so the
// prompt's baked `--pass` stamp stays valid.
//
// The slot-freeing half is the one that matters at scale, so this scenario runs with a cap of ONE
// workspace and a second brief waiting: if a parked run still held its slot, the second item could
// never be claimed.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

scenario(
  {
    name: "ask-human",
    briefs: {
      "needs-answer": "# Needs an answer\n\nAmbiguous requirement — the agent should ask.\n",
      "second-item": "# Second item\n\nShould still get picked up while the first waits.\n",
    },
    config: (p) => ({
      // ONE slot: the second item can only be claimed if the parked one has released it.
      limits: { max_active_workspaces: 1, step_budget_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "asking", source: "briefs", workspace_name: "a/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { steps: { work: { signal: "ask-human", text: "Should the banner be blue or green?" } } },
  },
  async (w) => {
    const key = "needs-answer";

    await w.waitFor(() => w.db.run(key)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 90_000 });

    // The question left the factory through the source's own reply channel.
    const question = w.humanInbox(`${key}-q1.md`);
    expect(question, "the question is posted to the work source").toBeTruthy();
    expect(question!).toContain("Should the banner be blue or green?");
    expect(question!).toContain("## Answer");
    expect(w.db.eventTypes(key)).toContain("human_question");

    // The park released the run's slot: the second brief gets claimed even though the cap is 1.
    await w.waitFor(() => w.db.run("second-item") !== undefined, {
      label: "a parked run holds no claim slot, so the next item is claimed",
      timeoutMs: 90_000,
    });

    // ── the human answers ─────────────────────────────────────────────────────────────────────
    // Switch the agent off "ask" first: the reply resumes the SAME step, and an agent that asked the
    // same question again would just re-park.
    w.setAgentScript({ steps: { work: { signal: "step-done" } } });
    w.answerHumanQuestion(key, "Blue.");
    // The reply poll backs off 60s after its first miss — an engine clock config can't compress, so
    // make it due now rather than sit out the wall.
    w.db.dueNow("human_reply_poll", w.db.run(key)!.id);

    await w.waitFor(() => w.db.run(key)?.phase === "running", { label: "the reply is picked up and the step resumes", timeoutMs: 120_000 });
    expect(w.db.eventTypes(key)).toContain("human_reply");

    // The answer is written where the agent was told to look, and the step continues on its own pass.
    const run = w.db.run(key)!;
    expect(w.db.step(run.id, "work")!.pass, "resuming after a reply does not bump the pass").toBe(1);

    await w.waitForEnd(key, "completed", { label: "the answered run finishes", timeoutMs: 120_000 });
    await w.waitForEnd("second-item", undefined, { label: "and so does the item that used its slot", timeoutMs: 120_000 });
  },
);
