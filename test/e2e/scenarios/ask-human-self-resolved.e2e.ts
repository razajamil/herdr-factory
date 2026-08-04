// The other half of the ask-human cord (see ask-human.e2e.ts, which covers the answered path): an
// agent that asked a question and then got past the blocker ON ITS OWN. Its step-done is a genuine
// terminal, so the run must follow it instead of waiting out a reply nobody is going to send.
//
// RWR-18609 in the wild: an evidence step blocked on a local login asked a human at 09:56, unblocked
// itself, signalled step-done at 11:00 — and the run sat in `waiting_for_human` for good, because the
// phase's only exits were a reply, a merge, a stale item, or a failing poll. The done flag was
// recorded and then ignored on every tick after.
//
// The signal is issued through the CLI here rather than by the scripted agent because that is exactly
// how it arrives in production: the agent's turn already ENDED at the ask, and with no reply coming
// nothing re-prompts that pane — the second signal comes from a later, self-directed turn.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

scenario(
  {
    name: "ask-human-self-resolved",
    briefs: { "unblocks-itself": "# Unblocks itself\n\nThe agent asks, then finds the answer on its own.\n" },
    config: (p) => ({
      limits: { step_budget_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "asking", source: "briefs", workspace_name: "s/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    agent: { steps: { work: { signal: "ask-human", text: "Which flag wins?" }, review: { commit: false } } },
  },
  async (w) => {
    const key = "unblocks-itself";

    await w.waitForPhase(key, "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 90_000 });
    expect(w.humanInbox(`${key}-q1.md`)!, "the question went out through the source").toContain("Which flag wins?");

    // The agent comes back on its own — no reply was ever written to the inbox — and signals its
    // terminal for the pass it is on.
    w.setAgentScript({ steps: { review: { commit: false } } });
    const pass = w.db.step(w.db.run(key)!.id, "work")!.pass;
    const done = w.factory.cli(["step-done", key, "work", "--pass", String(pass)]);
    expect(done.code, done.stderr).toBe(0);

    // The park is rescued by the step's own completion, and the belt moves on. Asserted on the event,
    // not on `phase === "running"`: the rescued run advances through review and may reach the end of
    // the belt before a poll ever samples the phase.
    await w.waitForEvent(key, "resumed", { label: "the finished step un-parks the run", timeoutMs: 60_000 });
    const resumed = w.db.event(key, "resumed");
    expect(resumed?.data.reason, "un-parked by the step's own terminal, not by a human").toBe("step_done_after_human_park");

    // The now-moot question is closed, so nothing keeps polling the source for an answer to it…
    expect(w.db.eventTypes(key)).toContain("human_question_moot");
    // …and the human looking at the posted thread is told it needs no reply.
    await w.waitForNote(key, /no answer needed/);

    await w.waitForEnd(key, "completed", { label: "the rescued run runs to the end of the belt", timeoutMs: 150_000 });
  },
);
