// Regression test for a bug this suite found: a signal that arrived before the engine had recorded
// the dispatch was rejected — and the rejection exited 0, so the agent could not tell. The run then
// waited for a signal that would never come again, until its step budget expired.
//
// `reconcileClaiming` dispatches the belt's first step with `spawnStep`, which blocks until herdr
// reports the agent ready for input — but the agent's prompt already rode in on the argv, so it can
// be working, and finishing, while that call is still outstanding. `run.step` was written only after
// it returned, so `step-done` hit `"work" is not the run's active step ("none") — signal ignored`.
//
// Fix: `run.step` is recorded BEFORE the dispatch (every later step already did this), and a rejected
// signal now exits non-zero so an agent can see it.
//
// The agent here starts work the instant it is exec'd (`HF_AGENT_STARTUP_MS: "0"` removes the boot
// dwell that a real harness's startup provides), which is what makes the race certain rather than
// occasional.
import { expect } from "vitest";
import { expectStepDone, expectTimeline, scenario } from "../harness/index.ts";

scenario(
  {
    name: "fast-signal",
    processEnv: { HF_AGENT_STARTUP_MS: "0" },
    briefs: { "fast-item": "# Fast item\n\nAn agent that finishes before the dispatch call returns.\n" },
    config: (p) => ({
      // A tight budget: if the first signal were dropped the run would park here instead of finishing,
      // which is exactly how this bug presented.
      limits: { step_budget_seconds: 30 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "fast-belt",
          source: "briefs",
          workspace_name: "fast/{{work_id}}",
          steps: [{ type: "work" }, { type: "review" }],
        },
      ],
    }),
    agent: { default: { workMs: 0 }, steps: { review: { commit: false } } },
  },
  async (w) => {
    const key = "fast-item";

    await w.waitForEnd(key, "completed", { label: "the belt completes despite an instant first signal", timeoutMs: 120_000 });
    expectStepDone(w, key, ["work", "review"]);
    expectTimeline(w, key, ["claimed", "worktree_created", "step_done", "step_spawned", "step_done", "torn_down"]);

    // The race really happened — the first step-done is recorded BEFORE the dispatch that "started"
    // the step it completes. That inversion is the bug's fingerprint; if it ever stops happening the
    // scenario has lost its teeth and needs re-tuning (a slower agent than the dispatch call).
    const types = w.db.eventTypes(key);
    expect(types.indexOf("step_done"), "the first signal beat its own step_spawned").toBeLessThan(types.indexOf("step_spawned"));

    // The first signal was ACCEPTED on its first attempt — from both ends: the engine never logged a
    // rejection, and the agent never had to fall back on its retry loop.
    expect(w.factory.repoLog(400), "the engine never ignored a signal").not.toContain("is not the run's active step");
    expect(w.agentLog(), "the agent never saw a rejected signal").not.toContain("signal rejected");

    // The other half of the fix: a signal the engine REFUSES has to fail loudly, or an agent stops
    // believing it finished. This one names a run that has already ended.
    const rejected = w.factory.cli(["step-done", key, "work"]);
    expect(rejected.code, `a rejected signal must exit non-zero (stdout: ${rejected.stdout.trim()})`).toBe(1);
    expect(rejected.stderr).toContain("no active run");
    expect(w.db.run(key)!.attention_reason_code, "and the run never parked on a lost signal").toBeNull();
  },
);
