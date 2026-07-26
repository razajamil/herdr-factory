// A belt of `custom` steps — the fully user-driven pipeline. Nothing produces a pull request, so the
// run must end on the LAST step's step-done with outcome `completed`, and none of the PR machinery
// (pr_opened, the reviewing watch, CI polling) may appear.
//
// It also covers the authoring surface: a `custom` step's prompt_file IS its body, resolved from the
// repo's config folder (prompt_file_source defaults to `config`), with the engine adding only the
// handover scaffold + token substitution.
import { expect } from "vitest";
import { expectNoEvent, expectNoPendingIntents, expectStepDone, expectTimeline, scenario } from "../harness/index.ts";

const RESEARCH_PROMPT = [
  "# Research @@KEY@@",
  "",
  "Read the work item at @@WORK_DOC@@ (kind: @@WORK_DOC_KIND@@) and write what you learn to",
  "@@HANDOFF_OUT@@. You are on belt @@BELT@@, step @@STEP@@ of @@STEPS@@, in @@WORKTREE@@.",
  "",
  "When you are done: `@@STEP_DONE_CMD@@`",
  "",
].join("\n");

const PROPOSE_PROMPT = [
  "# Propose for @@KEY@@",
  "",
  "The prior step's notes are at @@HANDOFF_IN@@. Write the proposal to @@HANDOFF_OUT@@.",
  "If you cannot decide, ask: `@@ASK_HUMAN_CMD@@`",
  "",
  "When you are done: `@@STEP_DONE_CMD@@`",
  "",
].join("\n");

scenario(
  {
    name: "custom-belt",
    briefs: {
      "dark-mode": "# Explore dark mode\n\nWould a dark theme be worth it?\n",
    },
    configFiles: {
      "prompts/research.md": RESEARCH_PROMPT,
      "prompts/propose.md": PROPOSE_PROMPT,
    },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "ideas", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "ideas-to-proposals",
          source: "ideas",
          workspace_name: "research/{{work_id}}-{{work_slug}}",
          steps: [
            { type: "custom", name: "research", prompt_file: "prompts/research.md" },
            { type: "custom", name: "propose", prompt_file: "prompts/propose.md", budget_seconds: 120 },
          ],
        },
      ],
    }),
    // custom steps declare no `commits` product, so the agent must not commit (nothing enforces
    // read-only here — it simply has no reason to).
    agent: { default: { commit: false } },
  },
  async (w) => {
    const key = "dark-mode";

    await w.waitFor(() => w.db.run(key) !== undefined, { label: "the idea is claimed" });
    expect(w.db.run(key)!.branch).toMatch(/^research\/dark-mode-explore-dark-mode-[a-z0-9]+$/);

    await w.waitForEnd(key, "completed", { label: "the last custom step ends the run", timeoutMs: 120_000 });

    expectStepDone(w, key, ["research", "propose"]);
    expectTimeline(w, key, ["claimed", "worktree_created", "step_spawned", "step_done", "step_spawned", "step_done", "torn_down"]);

    // No PR-producing step ⇒ no PR machinery at all, and the fake gh is never even consulted.
    expectNoEvent(w, key, "pr_opened");
    expectNoEvent(w, key, "resolver_woken");
    expect(w.db.run(key)!.pr_number).toBeNull();
    expect(w.gh.calls().filter((c) => c.subcommand.startsWith("pr")), "no gh PR calls on a custom belt").toEqual([]);

    // The authored prompt is what the agent actually received: tokens substituted, scaffold appended.
    const rendered = w.renderedPrompt("research");
    expect(rendered, "the research prompt reached the agent").toBeTruthy();
    expect(rendered!).toContain("# Research dark-mode");
    expect(rendered!).toContain("task.md"); // @@WORK_DOC@@ for a local_markdown file item
    expect(rendered!, "no token may reach an agent unrendered").not.toMatch(/@@[A-Z_]+@@/);
    expect(rendered!, "the handover scaffold is appended").toMatch(/step-done/);

    expect(w.db.workItem("ideas", key)?.status, "custom-belt terminal state").toBe("done");
    expectNoPendingIntents(w);
  },
);
