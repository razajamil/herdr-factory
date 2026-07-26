// A source with no credentials is PAUSED, not broken. This is the failure every new install hits, and
// the guarantees are that it degrades locally and reverses cleanly:
//
//   * the unauthenticated source makes NO network call at all (the gate decides before the client is
//     ever reached — asserted here against a stub that would have recorded one);
//   * it takes on no work, and says so through `/status` and a notification;
//   * every other belt in the same repo keeps shipping; and
//   * supplying the credentials un-pauses it, with no restart beyond a config reload.
import { expect } from "vitest";
import { emptyJiraBoard } from "../harness/sources/http-stub.ts";
import { scenario } from "../harness/index.ts";

interface StatusBody {
  sources: { name: string; type: string; auth?: { state: string; detail?: string } }[];
}

const jira = emptyJiraBoard();

scenario(
  {
    name: "missing-api-key",
    beforeStart: () => jira.listen(),
    afterStop: () => jira.close(),
    briefs: { "local-work": "# Local work\n\nThis one has everything it needs.\n" },
    config: (p) => ({
      work_sources: [
        { type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } },
        // A REACHABLE board that answers "no issues" — so the only thing stopping the engine from
        // calling it is the auth gate, which is exactly what this scenario is about. No `env` file is
        // written, so JIRA_EMAIL / JIRA_API_TOKEN are both absent.
        { type: "jira", name: "board", jira: { base_url: jira.url, project: "APP", board: 1 } },
      ],
      belt: [
        { name: "local", source: "briefs", workspace_name: "l/{{work_id}}", steps: [{ type: "work" }] },
        { name: "tickets", source: "board", label: "agent", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] },
      ],
    }),
  },
  async (w) => {
    // The healthy belt is unaffected by its unauthenticated neighbour.
    await w.waitForEnd("local-work", "completed", { label: "the credentialed belt still ships", timeoutMs: 120_000 });

    // Not one request reached the board: the gate stops the source before any network call.
    expect(jira.seen(), "an unauthenticated source is never dialled").toEqual([]);
    expect(w.db.runs().filter((r) => r.work_source === "board"), "and it claims nothing").toEqual([]);

    // It is reported, not silently skipped.
    const status = await w.factory.repoApi<StatusBody>("GET", "status");
    const board = status.sources.find((s) => s.name === "board")!;
    expect(board.auth?.state, `jira auth state (detail: ${board.auth?.detail ?? "-"})`).toBe("down");
    expect(w.herdr.notifications().some((n) => /auth|credential|authenticat/i.test(`${n.title} ${n.body}`)), "the operator is notified").toBe(true);

    // `auth status` says the same thing without touching the network.
    const auth = w.factory.cli(["auth", "status"]);
    expect(auth.code).toBe(0);
    expect(auth.stdout).toMatch(/board \(jira\)[\s\S]*JIRA_EMAIL/);

    // ── the operator supplies the credentials ─────────────────────────────────────────────────
    w.writeRepoEnv({ JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "not-a-real-token" });
    await w.factory.api("POST", "/reload", {});

    await w.waitFor(() => jira.seen("/rest/agile/1.0/board/").length > 0, {
      label: "the un-paused source starts polling its board",
      timeoutMs: 60_000,
    });
    await w.waitFor(
      async () => (await w.factory.repoApi<StatusBody>("GET", "status")).sources.find((s) => s.name === "board")?.auth?.state === "ok",
      { label: "and `/status` reports it healthy again", timeoutMs: 60_000 },
    );

    // The pause left no wreckage behind: the healthy run is intact and the board found no work.
    expect(w.db.run("local-work")!.outcome).toBe("completed");
    expect(w.db.runs().filter((r) => r.work_source === "board")).toEqual([]);
  },
);
