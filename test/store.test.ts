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

describe("Store — guard_counters (generalized capped-guard storage)", () => {
  it("counts (run, step, guard) triples independently — two capped guards on one step never collide", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-GC" });
    // same run+step, two different guards → independent counters (the collision the old single
    // capture_attempts column could not represent).
    expect(store.bumpGuardCounter(run.id, "evidence", "capture_cap")).toBe(1);
    expect(store.bumpGuardCounter(run.id, "evidence", "capture_cap")).toBe(2);
    expect(store.bumpGuardCounter(run.id, "evidence", "other_cap")).toBe(1);
    expect(store.guardCounter(run.id, "evidence", "capture_cap")).toBe(2);
    expect(store.guardCounter(run.id, "evidence", "other_cap")).toBe(1);
    // reset is per-triple + a no-op when nothing is counted (the fixed resume leak).
    store.resetGuardCounter(run.id, "evidence", "capture_cap");
    expect(store.guardCounter(run.id, "evidence", "capture_cap")).toBe(0);
    expect(store.guardCounter(run.id, "evidence", "other_cap")).toBe(1); // untouched
    expect(() => store.resetGuardCounter(run.id, "review", "capture_cap")).not.toThrow(); // no counter → no-op
  });
});

describe("Store", () => {
  it("creates a run in claiming and counts it active", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1", summary: "s", issueType: "Bug", branch: "fix/K-1-s" });
    expect(run.phase).toBe("claiming");
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "jira", "K-1")?.id).toBe(run.id);
  });

  it("updates fields and bumps updated_at", () => {
    const { store, tick } = makeStore(1000);
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-2" });
    tick(5);
    store.updateRun(run.id, { phase: "running", step: "fix", prNumber: 42, workspaceId: "w1" });
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    expect(got.prNumber).toBe(42);
    expect(got.workspaceId).toBe("w1");
    expect(got.updatedAt).toBe(1005);
  });

  it("run_steps: upsert inserts then patches, markStepDone, per-run listing", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-R" });
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

  it("countOccupying: parks and idle PR-watches hold no slot; a reviewing run counts only while resolving", () => {
    const { store } = makeStore();
    const mk = (key: string, phase: string, extra: Record<string, unknown> = {}) => {
      const r = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: key });
      store.updateRun(r.id, { phase: phase as never, ...extra });
      return r;
    };
    mk("W-run", "running", { step: "fix" }); // actively worked → occupies
    mk("W-park", "attention"); // parked → no slot
    mk("W-human", "waiting_for_human"); // parked → no slot
    const rev = mk("W-rev", "reviewing", { prNumber: 1, resolverActive: false }); // idle watch → no slot
    expect(store.countActive("r")).toBe(4);
    expect(store.countOccupying("r")).toBe(1); // only the running one

    // The resolver starts working → the reviewing run now occupies a slot.
    store.updateRun(rev.id, { resolverActive: true });
    expect(store.countOccupying("r")).toBe(2);

    // It finishes and goes idle again → slot released, PR still watched.
    store.updateRun(rev.id, { resolverActive: false });
    expect(store.countOccupying("r")).toBe(1);
  });

  it("ends a run -> not active, has outcome + ended_at", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-3" });
    store.endRun(run.id, "merged");
    expect(store.countActive("r")).toBe(0);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(got.endedAt).not.toBeNull();
  });

  it("supports multiple attempts per ticket and keeps history", () => {
    const { store, db } = makeStore();
    const a = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-4" });
    store.endRun(a.id, "closed");
    const b = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-4" }); // re-claim after a failed attempt
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "jira", "K-4")?.id).toBe(b.id);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ticket_key = 'K-4'").get() as { n: number };
    expect(n).toBe(2);
  });

  it("records events with JSON detail", () => {
    const { store, db } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-5" });
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
    const j = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "DUP-1", branch: "fix/DUP-1" });
    const m = store.createRun({ repo: "r", workSource: "local_markdown", belt: "gen", ticketKey: "DUP-1", branch: "feature/DUP-1" });
    expect(store.countActive("r")).toBe(2);
    expect(store.activeRunForTicket("r", "jira", "DUP-1")?.id).toBe(j.id);
    expect(store.activeRunForTicket("r", "local_markdown", "DUP-1")?.id).toBe(m.id);
    // The key-only lookup (for the manual CLI) returns BOTH — the caller errors on ambiguity.
    expect(store.activeRunsForKey("r", "DUP-1").map((x) => x.workSource).sort()).toEqual(["jira", "local_markdown"]);
  });

  it("records the work_source + belt on each run, and the active step", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "local_markdown", belt: "gen", ticketKey: "M-1" });
    expect(store.getRun(run.id)!.workSource).toBe("local_markdown");
    expect(store.getRun(run.id)!.belt).toBe("gen");
    expect(store.getRun(run.id)!.step).toBeNull();
    store.updateRun(run.id, { phase: "running", step: "research" });
    expect(store.getRun(run.id)!.step).toBe("research");
  });

  it("work_items accepts the custom-belt terminal state 'done' (migration v7)", () => {
    const { store } = makeStore();
    expect(store.setWorkItemStatus("r", "lm", "idea-1", "done")).toBe(true);
    expect(store.getWorkItem("r", "lm", "idea-1")!.status).toBe("done");
    // a 'done' item is terminal — listing by 'todo' must not surface it
    expect(store.listWorkItems("r", "lm", "todo").map((x) => x.key)).not.toContain("idea-1");
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
    // Include watch_deadline + pr_number + last_thread_sig (all part of the v1 CREATE TABLE) so v17's
    // and v18's DROP COLUMNs apply cleanly (resolver_active is ADDED by v17, then dropped by v18), and
    // seed run_steps (created back in v4) so v9's ALTER applies — a genuine v5 DB always has both.
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (5);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, ticket_key TEXT, phase TEXT,
        pr_number INTEGER, last_thread_sig TEXT,
        watch_deadline INTEGER, created_at INTEGER, updated_at INTEGER, ended_at INTEGER);
      INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','OLD-1','fixing',1,1);
      CREATE TABLE run_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, step TEXT NOT NULL,
        pane_id TEXT, session_id TEXT, progress_sig TEXT, progress_at INTEGER,
        done INTEGER NOT NULL DEFAULT 0, started_at INTEGER, done_at INTEGER);
    `);
    migrate(db);
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(6);
    const row = db.prepare("SELECT work_source FROM runs WHERE ticket_key = 'OLD-1'").get() as { work_source: string };
    expect(row.work_source).toBe("jira"); // backfilled in the same migration
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get()).toBeTruthy();
    expect(() => migrate(db)).not.toThrow(); // re-running is a no-op
  });

  it("run_products backs prNumber/resolverActive/lastThreadSig + gates reviewing occupancy (v18)", () => {
    const { store } = makeStore(1000);
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "b", ticketKey: "K-1" });
    // A fresh run has no pull_request row → the LEFT JOIN yields null/idle.
    expect(store.getRun(run.id)!.prNumber).toBeNull();
    expect(store.getRun(run.id)!.resolverActive).toBe(false);
    // Adopting a PR + recording a thread signature routes into run_products (not the runs table).
    store.updateRun(run.id, { prNumber: 42, lastThreadSig: "sig-1" });
    const r = store.getRun(run.id)!;
    expect(r.prNumber).toBe(42);
    expect(r.lastThreadSig).toBe("sig-1");
    expect(r.resolverActive).toBe(false); // partial upsert left active untouched
    // A reviewing run with an idle resolver holds NO slot; an active resolver holds one.
    store.updateRun(run.id, { phase: "reviewing", resolverActive: false });
    expect(store.countOccupying("r")).toBe(0);
    store.updateRun(run.id, { resolverActive: true });
    expect(store.getRun(run.id)!.resolverActive).toBe(true);
    expect(store.countOccupying("r")).toBe(1);
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

  describe("evidence-upload outbox", () => {
    function seedRun(store: Store) {
      return store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-EV", summary: "s", issueType: "Bug", branch: "fix/K-EV" });
    }

    it("enqueue sets the lease (not due until it elapses) and is idempotent per prefix", () => {
      const { store, setNow } = makeStore(1000);
      const run = seedRun(store);
      const job = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/A", evidenceDir: "/wt/ev" });
      expect(job.nextAttemptAt).toBe(1000 + 300); // lease
      expect(store.dueEvidenceUploads("r")).toHaveLength(0); // leased — not yet due
      setNow(1300);
      expect(store.dueEvidenceUploads("r").map((u) => u.id)).toEqual([job.id]);
      // Re-enqueue the SAME prefix reopens the same row (no duplicate).
      const again = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/A", evidenceDir: "/wt/ev" });
      expect(again.id).toBe(job.id);
    });

    it("a fresh prefix supersedes prior undelivered uploads for the run (re-capture)", () => {
      const { store, setNow } = makeStore(1000);
      const run = seedRun(store);
      const a = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/A", evidenceDir: "/wt/ev" });
      const b = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/B", evidenceDir: "/wt/ev" });
      setNow(1300);
      const due = store.dueEvidenceUploads("r").map((u) => u.id);
      expect(due).toContain(b.id);
      expect(due).not.toContain(a.id); // A abandoned
      expect(store.getEvidenceUpload(a.id)!.abandonedAt).not.toBeNull();
    });

    it("recordEvidenceAttempt backs off + stamps kind; auth kind is SSO-stuck; delivered can't reopen", () => {
      const { store, setNow } = makeStore(1000);
      const run = seedRun(store);
      const job = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/A", evidenceDir: "/wt/ev" });
      setNow(1300);
      const after = store.recordEvidenceAttempt(job.id, "sso expired", "auth")!;
      expect(after.attempts).toBe(1);
      expect(after.errorKind).toBe("auth");
      expect(after.nextAttemptAt).toBe(1300 + 60); // first backoff
      expect(store.authStuckEvidenceUpload("r")).toBe(true);
      // Deliver, then a late failure must NOT reopen it (guard).
      store.markEvidenceDelivered(job.id);
      expect(store.authStuckEvidenceUpload("r")).toBe(false);
      store.recordEvidenceAttempt(job.id, "late", "transient");
      expect(store.getEvidenceUpload(job.id)!.deliveredAt).not.toBeNull();
      expect(store.pendingEvidenceUploads("r")).toHaveLength(0);
    });

    it("permanent-fail and teardown-abandon both remove a row from pending/due", () => {
      const { store, setNow } = makeStore(1000);
      const run = seedRun(store);
      const perm = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/A", evidenceDir: "/wt/ev" });
      store.markEvidencePermanentFailed(perm.id, "bucket does not exist");
      setNow(1300);
      expect(store.dueEvidenceUploads("r")).toHaveLength(0);
      expect(store.pendingEvidenceUploads("r")).toHaveLength(0);
      // A second, still-pending upload gets dropped by teardown.
      const live = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "p/B", evidenceDir: "/wt/ev" });
      expect(store.undeliveredEvidenceUploadsForRun(run.id).map((u) => u.id)).toEqual([live.id]);
      expect(store.abandonEvidenceUploadsForRun(run.id, "torn down")).toBe(1);
      expect(store.undeliveredEvidenceUploadsForRun(run.id)).toHaveLength(0);
    });
  });

  describe("source OAuth tokens (source_auth)", () => {
    it("save / get / clear round-trips; upsert rotates tokens but keeps created_at; scoped by (repo, source)", () => {
      const { store, setNow } = makeStore(1000);
      expect(store.getSourceAuth("r", "jira")).toBeUndefined();
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a1", refreshToken: "r1", expiresAt: 5000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "read:jira-work offline_access" });
      const t1 = store.getSourceAuth("r", "jira")!;
      expect([t1.accessToken, t1.refreshToken, t1.cloudId, t1.method]).toEqual(["a1", "r1", "c1", "oauth"]);
      expect(t1.createdAt).toBe(1000);

      setNow(2000);
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a2", refreshToken: "r2", expiresAt: 9000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "read:jira-work offline_access" });
      const t2 = store.getSourceAuth("r", "jira")!;
      expect([t2.accessToken, t2.refreshToken, t2.expiresAt]).toEqual(["a2", "r2", 9000]);
      expect(t2.createdAt).toBe(1000); // preserved
      expect(t2.updatedAt).toBe(2000);

      expect(store.getSourceAuth("r", "other")).toBeUndefined(); // scoped by source
      expect(store.getSourceAuth("other-repo", "jira")).toBeUndefined(); // and by repo
      expect(store.clearSourceAuth("r", "jira")).toBe(true);
      expect(store.getSourceAuth("r", "jira")).toBeUndefined();
      expect(store.clearSourceAuth("r", "jira")).toBe(false); // already gone
    });

    it("setSourceAuthAccount records the whoami label + it survives a token refresh (upsert)", () => {
      const { store, setNow } = makeStore(1000);
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a1", refreshToken: "r1", expiresAt: 5000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "s" });
      expect(store.getSourceAuth("r", "jira")!.accountLabel).toBeNull(); // not set at first save

      store.setSourceAuthAccount("r", "jira", "Raza Jamil <raza@x.com>");
      expect(store.getSourceAuth("r", "jira")!.accountLabel).toBe("Raza Jamil <raza@x.com>");

      // A later token refresh (saveSourceAuth upsert) rotates the token but must NOT wipe the account.
      setNow(2000);
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a2", refreshToken: "r2", expiresAt: 9000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "s" });
      const t = store.getSourceAuth("r", "jira")!;
      expect([t.accessToken, t.accountLabel]).toEqual(["a2", "Raza Jamil <raza@x.com>"]);
    });
  });

  describe("transition outbox — auth recovery", () => {
    it("retryTransitionsForSource makes a source's undelivered write-backs due now (only that source, only undelivered)", () => {
      const { store } = makeStore();
      const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1", branch: "b" });
      const other = store.createRun({ repo: "r", workSource: "gh", belt: "ship2", ticketKey: "G-1", branch: "b2" });
      const held = store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_review" });
      const otherSrc = store.enqueueTransition({ runId: other.id, repo: "r", workSource: "gh", ticketKey: "G-1", toState: "in_review" });
      // Back the jira intent off (as an auth failure would), so it's no longer due.
      store.recordTransitionAttempt(held.id, "401 not authenticated");
      expect(store.getTransitionIntent(held.id)!.nextAttemptAt).toBe(1060);
      expect(store.dueTransitions("r").map((i) => i.id)).not.toContain(held.id);

      const requeued = store.retryTransitionsForSource("r", "jira");
      expect(requeued).toBe(1); // only the jira intent, and it was undelivered
      expect(store.getTransitionIntent(held.id)!.nextAttemptAt).toBe(1000); // due now
      expect(store.dueTransitions("r").map((i) => i.id)).toContain(held.id);
      // A different source's intent is untouched by a jira recovery.
      expect(store.getTransitionIntent(otherSrc.id)!.nextAttemptAt).toBe(1000);

      // A delivered intent is never resurrected.
      store.markTransitionDelivered(held.id);
      expect(store.retryTransitionsForSource("r", "jira")).toBe(0);
    });
  });
});
