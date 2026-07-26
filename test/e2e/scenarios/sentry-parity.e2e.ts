// Source parity, Sentry edition — the mirror image of Jira. Sentry issues are NEVER moved for
// lifecycle: the status of record is the factory's own ledger, and the only Sentry-side write is the
// configured courtesy at merge. There is also no pickup label at all: the config query IS the filter,
// so belts route by `match`/priority.
//
// And the behaviour no other source has: a release REGRESSION reopens a terminal item. "We thought we
// fixed it, but a later release still hits it" has to put the work back on the belt.
import { expect } from "vitest";
import { SentryFake } from "../harness/sources/sentry-fake.ts";
import { scenario } from "../harness/index.ts";

const sentry = new SentryFake({ organization: "acme", project: "backend" });

scenario(
  {
    name: "sentry-parity",
    timeoutMs: 360_000,
    beforeStart: async () => {
      await sentry.listen();
      sentry.seed({
        id: "4001",
        shortId: "BACKEND-7A",
        title: "TypeError: cannot read property 'id' of undefined",
        culprit: "app/routes/checkout.ts",
        level: "error",
        count: 42,
        userCount: 12,
        release: "1.4.0",
      });
    },
    afterStop: () => sentry.close(),
    env: { SENTRY_AUTH_TOKEN: "token" },
    config: () => ({
      work_sources: [
        {
          type: "sentry",
          name: "errors",
          poll_interval_seconds: 1,
          sentry: { base_url: sentry.url, organization: "acme", projects: ["backend"], query: "is:unresolved", on_merge: "comment" },
        },
      ],
      // No `label`: a sentry belt must not set one — the query is the filter.
      belt: [{ name: "errors-to-prs", source: "errors", workspace_name: "fix/{{work_id}}", steps: [{ type: "work" }, { type: "pr" }] }],
    }),
  },
  async (w) => {
    const key = "4001";

    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the error is claimed and reaches a PR", timeoutMs: 240_000 });

    // Lifecycle lives in the factory's OWN ledger — Sentry's issue status is untouched.
    expect(w.db.workItem("errors", key)?.status, "the internal ledger tracks the lifecycle").toBe("in_review");
    expect(sentry.status(key), "…and Sentry is not moved for lifecycle").toBe("unresolved");

    w.gh.merge(w.db.run(key)!.pr_number!);
    await w.waitForEnd(key, "merged", { label: "the merge tears the run down", timeoutMs: 120_000 });

    // The one Sentry-side write the config asked for: a courtesy note linking the merged PR.
    await w.waitFor(() => sentry.notes(key).length > 0, { label: "the on_merge note is posted", timeoutMs: 60_000 });
    expect(sentry.notes(key)[0]).toMatch(/pull|PR|#\d+/i);
    expect(sentry.status(key), "on_merge: comment leaves the status alone").toBe("unresolved");
    expect(w.db.workItem("errors", key)?.status).toBe("merged");

    // ── the fix didn't hold ───────────────────────────────────────────────────────────────────
    // The same error recurs on a LATER release than the one it was fixed on: the ledger reopens the
    // item (in place — never deleted) and the belt claims it again.
    sentry.setRelease(key, "1.5.0");
    sentry.markRegressed(key);
    await w.waitFor(() => w.db.runs().filter((r) => r.ticket_key === key).length > 1, {
      label: "a release regression puts the error back on the belt",
      timeoutMs: 180_000,
    });
    const attempts = w.db.runs().filter((r) => r.ticket_key === key);
    expect(attempts.length, "a second attempt, not a mutated first one").toBe(2);
    expect(attempts[0]!.branch).not.toBe(attempts[1]!.branch);
  },
);
