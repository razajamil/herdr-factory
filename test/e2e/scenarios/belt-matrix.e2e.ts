// One source, three belts, and the routing rules that decide which one claims what: priority order,
// a programmatic `match` predicate, first-match-wins, an `active: false` belt that must take nothing,
// and the per-source concurrency cap that stops one source monopolising the repo.
//
// This is the config surface most likely to be got wrong in a real repo, and it is invisible in unit
// tests: the routing only happens in Phase B against real eligible items.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

// `match` is a .ts module in the repo's config folder whose default export is (ctx) => boolean.
// The item is the source-agnostic base (key/summary/type/labels/fields) plus, for local_markdown,
// its front-matter — so a brief routes itself with a `type:` header.
const MATCH_BUGS = `export default function matchBugs({ item }) {
  return String(item.type ?? "").toLowerCase() === "bug";
}
`;
const MATCH_EVERYTHING = `export default function matchEverything() {
  return true;
}
`;

const brief = (title: string, type: string) => `---\ntitle: ${title}\ntype: ${type}\n---\n\n# ${title}\n`;

scenario(
  {
    name: "belt-matrix",
    timeoutMs: 300_000,
    briefs: {
      "a-bug": brief("A bug", "bug"),
      "a-chore": brief("A chore", "chore"),
      "another-bug": brief("Another bug", "bug"),
    },
    configFiles: { "match-bugs.ts": MATCH_BUGS, "match-everything.ts": MATCH_EVERYTHING },
    config: (p) => ({
      work_sources: [
        {
          type: "local_markdown",
          name: "briefs",
          // One slot for the whole SOURCE: however many belts pull from it, they share this.
          max_active_workspaces: 1,
          local_markdown: { folder: p.briefs },
        },
      ],
      belt: [
        // A paused belt is walked first (priority 5) and matches everything — and must still claim
        // nothing at all. `active: false` gates claiming BEFORE the source is even polled.
        { name: "paused", source: "briefs", priority: 5, active: false, match: "match-everything.ts", workspace_name: "p/{{work_id}}", steps: [{ type: "work" }] },
        { name: "bugs", source: "briefs", priority: 10, match: "match-bugs.ts", workspace_name: "bug/{{work_id}}", steps: [{ type: "work" }] },
        // No `match` ⇒ accepts anything its source surfaces, but only reached because `bugs` declined.
        { name: "chores", source: "briefs", priority: 20, workspace_name: "chore/{{work_id}}", steps: [{ type: "work" }] },
      ],
    }),
  },
  async (w) => {
    // Sample the concurrency while the work drains: the per-source cap is a promise about what the
    // engine will NEVER do, so it has to be observed over time rather than at the end.
    let peak = 0;
    await w.waitFor(
      () => {
        peak = Math.max(peak, w.db.activeRuns().filter((r) => r.phase === "running" || r.phase === "claiming").length);
        return ["a-bug", "a-chore", "another-bug"].every((k) => w.db.run(k)?.ended_at != null);
      },
      { label: "all three briefs are claimed and finished", timeoutMs: 240_000 },
    );

    // Routed by the predicate, not by order of arrival.
    expect(w.db.run("a-bug")!.belt).toBe("bugs");
    expect(w.db.run("another-bug")!.belt).toBe("bugs");
    expect(w.db.run("a-chore")!.belt, "no match ⇒ the later belt catches what the earlier declined").toBe("chores");

    // The paused belt saw everything first and still took nothing.
    expect(w.db.runs().filter((r) => r.belt === "paused"), "an inactive belt claims nothing").toEqual([]);

    // Each belt's own branch template was used, so the run really went through that belt's config.
    expect(w.db.run("a-bug")!.branch).toMatch(/^bug\//);
    expect(w.db.run("a-chore")!.branch).toMatch(/^chore\//);

    expect(peak, "the per-source cap of 1 was never exceeded").toBeLessThanOrEqual(1);
  },
);
