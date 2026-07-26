// The prompts, read by something that can misread them.
//
// Every other scenario runs an agent that was written to obey: it finds the signal command in the
// rendered prompt and executes it, so a prompt that is ambiguous, self-contradictory or missing a step
// still passes. This one hands the SHIPPED prompts to a real model and asks whether the work reaches a
// pull request. Nothing about the belt is special — no prompt overrides, no harness hints in the
// config — because the thing under test is what the factory actually says to agents.
//
// Non-gating by construction: skipped unless the tier is selected (`scripts/e2e --tier ds4`), and its
// assertions are about the OUTCOME the factory needs, not about how the model got there. What it
// really produces is evidence: the rendered prompts, the pane transcript, the argv herdr built for the
// kind, the wall clock and the turn count — all in the scenario's artifacts.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";
import { ds4AgentFlags, DS4_MODEL_REF } from "../harness/ds4.ts";

const KEY = "greet-command";

scenario(
  {
    name: "ds4-w2pr",
    tier: "ds4",
    // A local model on a dev machine thinks in tens of seconds per turn, and this is a whole belt.
    timeoutMs: 1_800_000,
    briefs: {
      // A brief a small model can actually finish, and whose result is checkable without reading code:
      // one new file, one line in the README. The point is the PROMPT contract, not the difficulty.
      [KEY]: [
        "# Add a greet script",
        "",
        "Add `scripts/greet.sh` that prints `hello from the factory` and make it executable.",
        "Then add a line to `README.md` under a `## Scripts` heading describing it.",
        "",
        "Keep it small. No dependencies.",
      ].join("\n"),
    },
    config: (p) => ({
      // Deliberately close to a real config: the shipped prompts, a work → pr belt, generous budgets.
      // `budget_seconds` is the one concession to a slow local model.
      limits: { tick_interval_seconds: 2, step_budget_seconds: 1500, stall_seconds: 1500 },
      agent: { command: "opencode", kind: "opencode", flags: ds4AgentFlags() },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "model-belt",
          source: "briefs",
          workspace_name: "ds4/{{work_id}}",
          steps: [{ type: "work", budget_seconds: 900 }, { type: "pr", budget_seconds: 600 }],
        },
      ],
    }),
  },
  async (w) => {
    const started = Date.now();

    // The factory's own contract, in order: an agent was dispatched, it signalled its step, the belt
    // advanced, and a PR exists. Anything the model did in between is transcript, not assertion.
    await w.waitFor(() => w.db.step(w.db.run(KEY)?.id ?? -1, "work")?.pane_id != null, {
      label: "the model's agent is dispatched into a pane",
      timeoutMs: 300_000,
    });
    const dispatched = Date.now();

    await w.waitFor(() => w.db.step(w.db.run(KEY)?.id ?? -1, "work")?.done === 1, {
      label: "the model followed the work prompt to its step-done signal",
      timeoutMs: 900_000,
    });
    const workDone = Date.now();

    await w.waitFor(() => (w.db.run(KEY)?.pr_number ?? null) != null, {
      label: "the model opened a pull request from the pr step",
      timeoutMs: 900_000,
    });

    const run = w.db.run(KEY)!;
    const pr = w.gh.pr(run.pr_number!)!;

    w.recordMetrics({
      model: DS4_MODEL_REF,
      dispatchMs: dispatched - started,
      workStepMs: workDone - dispatched,
      totalMs: Date.now() - started,
      prNumber: run.pr_number!,
      commits: Number(w.git(["rev-list", "--count", `origin/main..${run.branch}`], w.paths.repo).trim() || 0),
      agentTurns: (w.herdr.calls().filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt").length || 0) + 1,
    });

    // What the factory needs from any agent, model or not.
    expect(pr.headRefName, "the PR is opened from the run's branch").toBe(run.branch);
    expect(pr.state).toBe("OPEN");
    expect(w.db.events(KEY).map((e) => e.type), "the belt advanced through its steps").toContain("step_done");

    // And the work itself landed — not judged for quality, only that the model committed something on
    // the run's branch rather than signalling done with an empty tree.
    const changed = w.git(["diff", "--name-only", `origin/main..${run.branch}`], w.paths.repo).trim();
    expect(changed, "the model committed real changes to the run's branch").not.toBe("");
  },
);
