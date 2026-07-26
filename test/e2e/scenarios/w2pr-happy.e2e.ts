// The canonical flow, end to end, with nothing mocked below the factory: a markdown brief becomes a
// merged PR. Real herdr worktree + real panes + real agents signalling through the real CLI; only
// GitHub is a shim (a `gh` fake over a local bare `origin`).
//
// This is the scenario that would have caught the 0.7.5 `agent start` breakage: every step here is
// dispatched the way production dispatches it.
import { expect } from "vitest";
import { expectNoPendingIntents, expectStepDone, expectTimeline, scenario, transitions } from "../harness/index.ts";

scenario(
  {
    name: "w2pr-happy",
    briefs: {
      "add-hello": [
        "---",
        "title: Add a hello file",
        "type: task",
        "---",
        "# Add a hello file",
        "",
        "## Acceptance criteria",
        "- `work/hello.txt` exists",
        "",
      ].join("\n"),
    },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "briefs-to-prs",
          source: "briefs",
          workspace_name: "{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}",
          steps: [{ type: "work" }, { type: "review" }, { type: "pr" }],
        },
      ],
    }),
    // The default behaviour is already the happy path (commit on work/pr, read-only review, then
    // step-done); spelled out here because this scenario is the reference the others vary from.
    agent: {
      default: { signal: "step-done" },
      steps: { review: { commit: false } },
    },
  },
  async (w) => {
    const key = "add-hello";

    // ── the pipeline runs itself: claim → worktree → work → review → pr ────────────────────────
    await w.waitFor(() => w.db.run(key) !== undefined, { label: "the brief is claimed" });
    const run = w.db.run(key)!;
    expect(run.belt).toBe("briefs-to-prs");
    expect(run.work_source).toBe("briefs");
    expect(run.branch, "branch rendered from workspace_name").toMatch(/^chore\/add-hello-add-a-hello-file-[a-z0-9]+$/);

    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the pr step opens a PR", timeoutMs: 120_000 });
    const prNumber = w.db.run(key)!.pr_number!;
    const pr = w.gh.pr(prNumber);
    expect(pr?.state).toBe("OPEN");
    expect(pr?.headRefName, "the PR is on the run's branch").toBe(run.branch);

    // The work agent's commits really landed in the worktree's branch, and the pr agent pushed it.
    expect(w.git(["log", "--oneline", run.branch!]), "work commits on the branch").toMatch(/chore\(work\)/);
    expect(w.git(["ls-remote", "origin", run.branch!]), "branch pushed to origin").not.toBe("");

    // The engine hands off to the reviewing watch the moment a non-draft PR exists, without waiting
    // for the pr step's step-done.
    await w.waitForPhase(key, "reviewing", { label: "run enters the PR watch" });
    expectStepDone(w, key, ["work", "review"]);

    // ── the human review lands: merge ─────────────────────────────────────────────────────────
    w.gh.merge(prNumber);
    await w.waitForEnd(key, "merged", { label: "merge is detected and the run tears down", timeoutMs: 120_000 });

    // ── what the factory promises after a merge ───────────────────────────────────────────────
    // NB: there is no `merged` event — the engine records a merge as the terminal `transition` plus
    // `torn_down {outcome}` (ARCHITECTURE §6's event list still names one; see test/e2e/README.md).
    expectTimeline(w, key, [
      "claimed",
      "worktree_created",
      "step_spawned",
      "step_done",
      "step_spawned",
      "step_done",
      "step_spawned",
      "pr_opened",
      "torn_down",
    ]);
    expect(w.db.event(key, "torn_down")!.data.outcome).toBe("merged");
    // Status write-backs are monotonic and in order — a retried in_development must never land after
    // in_review (ARCHITECTURE §14).
    expect(transitions(w, key)).toEqual(["in_development", "in_review", "merged"]);
    expect(w.db.workItem("briefs", key)?.status, "internal ledger reaches the terminal state").toBe("merged");

    // Teardown reaped the worktree and the local branch, so a re-claim starts fresh off the base ref.
    const ended = w.db.run(key)!;
    expect(w.branchExists(ended.branch!), `local branch ${ended.branch} deleted`).toBe(false);
    expect(w.git(["worktree", "list"]), "worktree deregistered").not.toContain(ended.branch!);
    expectNoPendingIntents(w);

    // The brief itself is never modified — the folder is an input, not state.
    expect(w.humanInbox(`${key}-notes.md`), "no operator note for a clean run").toBeNull();
  },
);
