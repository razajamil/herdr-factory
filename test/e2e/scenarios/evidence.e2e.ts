// The evidence station, end to end. It is the one step that is opt-in by LAYOUT — it materialises
// only when its step ref names a tab+pane — and the one whose product leaves the worktree: captures
// are published through the `evidence.publisher` seam and the URLs are what a reviewer clicks.
//
// Delivery is durable by design (the URLs are predicted and published up front, the bytes retry in
// the background), so this asserts the whole chain: the step ran, the capture landed, the publish
// intent was DELIVERED, the bytes are on disk, and the resident server actually serves them.
//
// The belt carries a `pr` step on purpose. The bytes live in the worktree, so the engine drops a
// publish whose worktree teardown already removed — which a real belt never hits (the PR watch keeps
// the run alive for as long as review takes) but a three-step belt would race.
import { expect } from "vitest";
import { expectNoPendingIntents, scenario } from "../harness/index.ts";

/** Every step gets a layout pane. A belt that MIXES layout panes with dedicated-pane steps loses its
 *  layout: the engine's first dedicated spawn adds a tab, and the hook only builds into a fresh
 *  (1-tab/1-pane) worktree — so the layout is skipped and every layout-targeting step then waits for
 *  a pane that will never exist. See test/e2e/README.md. */
const LAYOUT = {
  id: "with-evidence",
  tabs: ["work", "evidence", "review", "pr"].map((title) => ({ title, panes: [{ title: "agent", agent: "claude" }] })),
};

scenario(
  {
    name: "evidence",
    timeoutMs: 300_000,
    briefs: { "prove-it": "# Prove it\n\n## Acceptance criteria\n- the banner is blue\n" },
    config: (p) => ({
      // `local`: zero cloud setup, and the URLs point at the resident server — which also means the
      // scenario can fetch them back through the exact route a reviewer would.
      evidence: { publisher: "local", key_prefix: "e2e", github_username: "harness" },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [LAYOUT],
      belt: [
        {
          name: "proving",
          source: "briefs",
          workspace_name: "e/{{work_id}}",
          default_layout: "with-evidence",
          steps: [
            { type: "work", tab: "work", pane: "agent" },
            { type: "evidence", tab: "evidence", pane: "agent" },
            { type: "review", tab: "review", pane: "agent" },
            { type: "pr", tab: "pr", pane: "agent" },
          ],
        },
      ],
    }),
    agent: { steps: { evidence: { commit: false, evidence: true }, review: { commit: false } } },
  },
  async (w) => {
    const key = "prove-it";

    // The publish happens INLINE on the happy path (the `evidence-upload` CLI publishes, then marks
    // its ledger intent delivered), and only a DEFERRED delivery records an `evidence_uploaded`
    // event — so the observable here is the delivered intent plus the bytes themselves, not the
    // timeline. (See test/e2e/README.md: an inline success leaves no trace in the event log.)
    await w.waitFor(() => w.db.intents({ kind: "evidence_publish" }).some((i) => i.status === "delivered"), {
      label: "the captures are published and the publish intent is delivered",
      timeoutMs: 240_000,
    });

    // The station ran (it would have been SKIPPED silently without its tab+pane). Asserted after the
    // publish, which the agent does BEFORE it signals the step done.
    const run = w.db.run(key)!;
    await w.waitFor(() => w.db.step(run.id, "evidence")?.done === 1, { label: "the evidence step finishes" });

    // The bytes are where the publisher says, under the documented key layout
    // (herdr-factory/<github_username>/<key_prefix>/<key>/<run>-<ts>/…), and the server serves them.
    const intent = w.db.intents({ kind: "evidence_publish" })[0]!;
    const prefix = (JSON.parse(intent.payload) as { keyPrefix: string }).keyPrefix;
    expect(prefix).toMatch(/^herdr-factory\/harness\/e2e\/prove-it\//);
    for (const file of ["evidence-before.png", "evidence-after.png"]) {
      expect(w.factory.evidenceFile(`${prefix}/${file}`), `${file} is on disk in the serve root`).toBeTruthy();
      expect((await w.factory.evidence(`${prefix}/${file}`)).status, `and the server serves ${file}`).toBe(200);
    }

    // Finish the run so nothing is left dangling, and confirm the delivery ledger is clean.
    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the pr step opens the PR", timeoutMs: 120_000 });
    w.gh.merge(w.db.run(key)!.pr_number!);
    await w.waitForEnd(key, "merged", { label: "the run merges and tears down", timeoutMs: 120_000 });
    expectNoPendingIntents(w);
  },
);
