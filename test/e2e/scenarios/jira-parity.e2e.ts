// Source parity, Jira edition: the same belt machinery, but against a source whose STATUS OF RECORD
// lives in the backend. What has to be true here and nowhere else:
//
//   * pickup is by the belt's LABEL on the board's own query — an unlabelled ticket is invisible;
//   * every lifecycle move is written back to Jira, in order, and the ordering is monotonic;
//   * a belt `effect` can target a CUSTOM status the source maps (`status.qa`), which is how a team
//     adds a column the engine's canonical vocabulary doesn't have; and
//   * the terminal write-back is opt-in — without `status.done` the factory leaves the ticket alone.
import { expect } from "vitest";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { scenario } from "../harness/index.ts";

// The workflow has to KNOW the belt's extra column: real Jira only offers transitions its workflow
// defines, and the engine reports "no transition from X to Y" for anything else — which is exactly
// what a misconfigured `status.<key>` looks like in production.
const jira = new JiraFake({ project: "APP", boardId: 254, statuses: ["QA Review", "Done"] });

scenario(
  {
    name: "jira-parity",
    timeoutMs: 300_000,
    beforeStart: async () => {
      await jira.listen();
      jira.seed({ key: "APP-1", summary: "Fix the login banner", type: "Bug", status: "To Do", labels: ["agent"] });
      // Same board, same status — but no pickup label, so the belt must never see it.
      jira.seed({ key: "APP-2", summary: "Not for the factory", type: "Task", status: "To Do", labels: [] });
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    config: () => ({
      work_sources: [
        {
          type: "jira",
          name: "board",
          jira: {
            base_url: jira.url,
            project: "APP",
            board: 254,
            // The canonical three, plus an EXTRA named status a belt effect can target by key.
            status: { todo: "To Do", in_development: "In Progress", review: "In Review", qa: "QA Review", done: "Done" },
          },
        },
      ],
      belt: [
        {
          name: "tickets",
          source: "board",
          label: "agent",
          workspace_name: "{{semantic_work_prefix}}/{{work_id}}",
          effects: [{ on: "enter", step: "review", to: "qa", anchor: "in_review" }],
          steps: [{ type: "work" }, { type: "review" }, { type: "pr" }],
        },
      ],
    }),
    agent: { steps: { review: { commit: false } } },
  },
  async (w) => {
    const key = "APP-1";

    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the labelled ticket runs to a PR", timeoutMs: 240_000 });
    expect(w.db.run("APP-2"), "an unlabelled ticket on the same board is never claimed").toBeUndefined();

    // The branch used Jira's issue type: a Bug becomes a fix/ branch.
    expect(w.db.run(key)!.branch).toMatch(/^fix\//);

    w.gh.merge(w.db.run(key)!.pr_number!);
    await w.waitForEnd(key, "merged", { label: "the merge tears the run down", timeoutMs: 120_000 });

    // Every move landed on the ticket, in lifecycle order — including the belt's custom QA column,
    // which sits just before `in_review` because that is the anchor it declared.
    await w.waitFor(() => jira.status(key) === "Done", { label: "the terminal write-back reaches Jira", timeoutMs: 60_000 });
    expect(jira.statusHistory(key)).toEqual(["In Progress", "QA Review", "In Review", "Done"]);

    // The engine never touched the ticket it wasn't given.
    expect(jira.statusHistory("APP-2")).toEqual([]);
  },
);
