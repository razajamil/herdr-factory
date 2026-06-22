import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { Store } from "../src/db/store.ts";

function makeStore(start = 1000) {
  let now = start;
  const db = openDb(":memory:");
  const store = new Store(db, () => now);
  return { store, db, setNow: (n: number) => { now = n; }, tick: (d: number) => { now += d; } };
}

describe("Store", () => {
  it("creates a run in claiming and counts it active", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-1", summary: "s", issueType: "Bug", branch: "fix/K-1-s" });
    expect(run.phase).toBe("claiming");
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "jira", "K-1")?.id).toBe(run.id);
  });

  it("updates fields and bumps updated_at", () => {
    const { store, tick } = makeStore(1000);
    const run = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-2" });
    tick(5);
    store.updateRun(run.id, { phase: "fixing", prNumber: 42, workspaceId: "w1" });
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("fixing");
    expect(got.prNumber).toBe(42);
    expect(got.workspaceId).toBe("w1");
    expect(got.updatedAt).toBe(1005);
  });

  it("run_steps: upsert inserts then patches, markStepDone, per-run listing", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-R" });
    expect(store.getRunStep(run.id, "fix")).toBeUndefined();

    // first upsert inserts the row + applies the patch
    const fix = store.upsertRunStep(run.id, "fix", { paneId: "w1:p1" });
    expect(fix.step).toBe("fix");
    expect(fix.paneId).toBe("w1:p1");
    expect(fix.done).toBe(false);
    expect(fix.startedAt).not.toBeNull();

    // subsequent upserts patch in place (no duplicate row)
    store.upsertRunStep(run.id, "fix", { sessionId: "sess-1", progressSig: "sha1", progressAt: 1234 });
    const got = store.getRunStep(run.id, "fix")!;
    expect(got.paneId).toBe("w1:p1"); // preserved
    expect(got.sessionId).toBe("sess-1");
    expect(got.progressSig).toBe("sha1");
    expect(got.progressAt).toBe(1234);

    store.markStepDone(run.id, "fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(true);
    expect(store.getRunStep(run.id, "fix")!.doneAt).not.toBeNull();

    store.upsertRunStep(run.id, "review", { paneId: "w1:p2" });
    expect(store.runStepsFor(run.id).map((s) => s.step)).toEqual(["fix", "review"]);
  });

  it("ends a run -> not active, has outcome + ended_at", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-3" });
    store.endRun(run.id, "merged");
    expect(store.countActive("r")).toBe(0);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(got.endedAt).not.toBeNull();
  });

  it("supports multiple attempts per ticket and keeps history", () => {
    const { store, db } = makeStore();
    const a = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-4" });
    store.endRun(a.id, "closed");
    const b = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-4" }); // re-claim after a failed attempt
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "jira", "K-4")?.id).toBe(b.id);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ticket_key = 'K-4'").get() as { n: number };
    expect(n).toBe(2);
  });

  it("records events with JSON detail", () => {
    const { store, db } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", ticketKey: "K-5" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-5", type: "claimed" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-5", type: "pr_opened", detail: { number: 7 } });
    const evs = db.prepare("SELECT type, detail FROM events WHERE run_id = ? ORDER BY id").all(run.id) as {
      type: string;
      detail: string | null;
    }[];
    expect(evs.map((e) => e.type)).toEqual(["claimed", "pr_opened"]);
    expect(JSON.parse(evs[1]!.detail!)).toEqual({ number: 7 });
  });

  it("scopes activeRunForTicket by source — same key in two sources is two runs", () => {
    const { store } = makeStore();
    const j = store.createRun({ repo: "r", workSource: "jira", ticketKey: "DUP-1", branch: "fix/DUP-1" });
    const m = store.createRun({ repo: "r", workSource: "local_markdown", ticketKey: "DUP-1", branch: "feature/DUP-1" });
    expect(store.countActive("r")).toBe(2);
    expect(store.activeRunForTicket("r", "jira", "DUP-1")?.id).toBe(j.id);
    expect(store.activeRunForTicket("r", "local_markdown", "DUP-1")?.id).toBe(m.id);
    // The key-only lookup (for the manual CLI) returns BOTH — the caller errors on ambiguity.
    expect(store.activeRunsForKey("r", "DUP-1").map((x) => x.workSource).sort()).toEqual(["jira", "local_markdown"]);
  });

  it("records the work_source on each run", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "local_markdown", ticketKey: "M-1" });
    expect(store.getRun(run.id)!.workSource).toBe("local_markdown");
  });

  it("work_items: upsert status is idempotent, tolerant of any→any, and merges metadata", () => {
    const { store, setNow } = makeStore(1000);
    expect(store.getWorkItem("r", "lm", "task-a")).toBeUndefined();

    // first set inserts (todo), reports a change
    expect(store.setWorkItemStatus("r", "lm", "task-a", "todo", { title: "Task A", path: "/f/task-a.md" })).toBe(true);
    let wi = store.getWorkItem("r", "lm", "task-a")!;
    expect(wi.status).toBe("todo");
    expect(wi.title).toBe("Task A");

    // same status again → no change (false), but metadata still refreshes
    expect(store.setWorkItemStatus("r", "lm", "task-a", "todo", { itemType: "task" })).toBe(false);
    expect(store.getWorkItem("r", "lm", "task-a")!.itemType).toBe("task");
    expect(store.getWorkItem("r", "lm", "task-a")!.title).toBe("Task A"); // preserved

    // non-adjacent jump (in_development → merged) is allowed, never throws
    store.setWorkItemStatus("r", "lm", "task-a", "in_development");
    setNow(1100);
    expect(store.setWorkItemStatus("r", "lm", "task-a", "merged")).toBe(true);
    wi = store.getWorkItem("r", "lm", "task-a")!;
    expect(wi.status).toBe("merged");
    expect(wi.path).toBe("/f/task-a.md"); // metadata preserved across status changes

    // listing filters by status + source
    store.setWorkItemStatus("r", "lm", "task-b", "todo");
    expect(store.listWorkItems("r", "lm", "todo").map((x) => x.key)).toEqual(["task-b"]);
    expect(store.listWorkItems("r", "lm").length).toBe(2);
  });

  it("migration v6 backfills pre-existing runs to 'jira' and adds work_items (idempotent)", () => {
    const db = new DatabaseSync(":memory:");
    // Simulate a pre-v6 DB: schema_version=5, a runs table WITHOUT work_source, one in-flight row.
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (5);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, ticket_key TEXT, phase TEXT,
        created_at INTEGER, updated_at INTEGER, ended_at INTEGER);
      INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','OLD-1','fixing',1,1);
    `);
    migrate(db);
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(6);
    const row = db.prepare("SELECT work_source FROM runs WHERE ticket_key = 'OLD-1'").get() as { work_source: string };
    expect(row.work_source).toBe("jira"); // backfilled in the same migration
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get()).toBeTruthy();
    expect(() => migrate(db)).not.toThrow(); // re-running is a no-op
  });

  it("TTL lock: acquire, block, steal after expiry, release", () => {
    const { store, setNow } = makeStore(1000);
    expect(store.acquireLock("capture", "A", 100)).toBe(true); // held until 1100
    expect(store.acquireLock("capture", "B", 100)).toBe(false); // blocked
    setNow(1101); // A expired
    expect(store.acquireLock("capture", "B", 100)).toBe(true); // steal
    store.releaseLock("capture", "A"); // wrong owner -> no-op
    expect(store.acquireLock("capture", "C", 100)).toBe(false); // B still holds
    store.releaseLock("capture", "B");
    expect(store.acquireLock("capture", "C", 100)).toBe(true);
  });
});
