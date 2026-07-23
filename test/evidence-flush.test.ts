import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the publisher FACTORY only — the flush obtains its publisher via createEvidencePublisher, so a
// fake publisher lets us drive delivery/probe outcomes. classifyError stays the REAL classifier so the
// flush's error-kind branching (auth/transient/permanent) is exercised end to end.
vi.mock("../src/clients/evidence.ts", async (orig) => {
  const actual = await orig<typeof import("../src/clients/evidence.ts")>();
  return { ...actual, createEvidencePublisher: vi.fn() };
});

import { createEvidencePublisher, classifyS3Error, type EvidencePublisher } from "../src/clients/evidence.ts";
import { flushEvidenceUploads } from "../src/core/reconcile.ts";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import type { Deps } from "../src/core/deps.ts";

const createPub = vi.mocked(createEvidencePublisher);
// The delivery + liveness seams the fake publisher exposes (reset per test).
const publish = vi.fn();
const probeLiveness = vi.fn();

const authErr = () => Object.assign(new Error("The SSO session associated with this profile has expired"), { name: "CredentialsProviderError" });
const permErr = () => Object.assign(new Error("bucket missing"), { name: "NoSuchBucket" });

function setup() {
  let now = 2000;
  const store = new Store(openDb(":memory:"), () => now);
  const notify = vi.fn(async (_title: string, _body: string) => {});
  const evidenceDir = mkdtempSync(join(tmpdir(), "ev-flush-"));
  writeFileSync(join(evidenceDir, "shot.png"), "x");
  const deps = {
    config: { repoName: "r", evidence: { publisher: "s3", bucket: "b", region: "us-east-1", cloudfrontDomain: "d.cf.net", keyPrefix: "", profile: "prof" }, limits: { attentionRenotifySeconds: 3600 } },
    store,
    herdr: { notify },
    github: { currentLogin: async () => null },
    log: () => {},
    now: () => now,
  } as unknown as Deps;
  const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-EV", branch: "fix/K-EV" });
  const enqueue = (dir = evidenceDir, prefix = "p/A") =>
    store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: prefix, evidenceDir: dir });
  return { deps, store, notify, evidenceDir, run, enqueue, setNow: (n: number) => { now = n; } };
}

describe("flushEvidenceUploads", () => {
  beforeEach(() => {
    publish.mockReset();
    // Default: creds still down, so the recovery-probe never re-queues unless a test opts in.
    probeLiveness.mockReset();
    probeLiveness.mockResolvedValue({ auth: true, reason: "down" });
    // A fake S3-shaped publisher: real classifier, mockable delivery + liveness.
    createPub.mockReset();
    createPub.mockReturnValue({
      kind: "s3",
      predictUrls: (prefix: string, files: string[]) => files.map((f) => `https://d.cf.net/${prefix}/${f}`),
      publish,
      classifyError: classifyS3Error,
      probeLiveness,
      deepProbe: async () => "ok",
    } as EvidencePublisher);
  });

  it("publishes a due job → delivered + evidence_uploaded event", async () => {
    const { deps, store, enqueue, setNow } = setup();
    const job = enqueue();
    setNow(2400); // past the enqueue lease
    publish.mockResolvedValueOnce({ files: ["shot.png"], urls: ["https://d.cf.net/p/A/shot.png"] });
    await flushEvidenceUploads(deps);
    expect(publish).toHaveBeenCalledOnce();
    expect(store.getEvidenceUpload(job.id)!.deliveredAt).not.toBeNull();
    expect(store.timeline("r", "K-EV").some((e) => e.type === "evidence_uploaded")).toBe(true);
  });

  it("auth failure defers (backoff) + notifies to `aws sso login`, then a later tick delivers", async () => {
    const { deps, store, notify, enqueue, setNow } = setup();
    const job = enqueue();
    setNow(2400);
    publish.mockRejectedValueOnce(authErr());
    await flushEvidenceUploads(deps);
    const afterFail = store.getEvidenceUpload(job.id)!;
    expect(afterFail.deliveredAt).toBeNull();
    expect(afterFail.errorKind).toBe("auth");
    expect(store.authStuckEvidenceUpload("r")).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![1]).toContain("aws sso login");

    // SSO refreshed; the next due tick uploads.
    setNow(2400 + 120); // past the 60s backoff
    publish.mockResolvedValueOnce({ files: ["shot.png"], urls: [] });
    await flushEvidenceUploads(deps);
    expect(store.getEvidenceUpload(job.id)!.deliveredAt).not.toBeNull();
    expect(store.authStuckEvidenceUpload("r")).toBe(false);
  });

  it("creds-recovery probe re-queues an auth-stuck upload due-now — delivers WITHIN the backoff window", async () => {
    const { deps, store, enqueue, setNow } = setup();
    const job = enqueue();
    setNow(2400);
    publish.mockRejectedValueOnce(authErr());
    await flushEvidenceUploads(deps); // attempt 1 fails → auth-stuck, next_attempt_at pushed to 2460
    expect(store.authStuckEvidenceUpload("r")).toBe(true);
    expect(store.getEvidenceUpload(job.id)!.nextAttemptAt).toBe(2460);

    // Only 5s later — still well inside the 60s backoff, so a plain flush would NOT retry. But creds
    // are now live: the probe fires (gated on the stuck row), re-queues due-now, and this same pass
    // uploads. No human action, no waiting out the backoff.
    setNow(2405);
    probeLiveness.mockResolvedValue({ auth: false, reason: "ok" });
    publish.mockResolvedValueOnce({ files: ["shot.png"], urls: [] });
    await flushEvidenceUploads(deps);
    expect(probeLiveness).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.getEvidenceUpload(job.id)!.deliveredAt).not.toBeNull();
    expect(store.authStuckEvidenceUpload("r")).toBe(false);
  });

  it("does NOT probe on the happy path (no stuck upload)", async () => {
    const { deps, enqueue, setNow } = setup();
    enqueue();
    setNow(2400);
    publish.mockResolvedValueOnce({ files: ["shot.png"], urls: [] });
    await flushEvidenceUploads(deps);
    expect(probeLiveness).not.toHaveBeenCalled();
  });

  it("permanent (config) error → permanent-failed + evidence_upload_failed event + one notify", async () => {
    const { deps, store, notify, enqueue, setNow } = setup();
    const job = enqueue();
    setNow(2400);
    publish.mockRejectedValueOnce(permErr());
    await flushEvidenceUploads(deps);
    expect(store.getEvidenceUpload(job.id)!.permanentFailedAt).not.toBeNull();
    expect(store.dueEvidenceUploads("r")).toHaveLength(0); // terminal — not retried
    expect(store.timeline("r", "K-EV").some((e) => e.type === "evidence_upload_failed")).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("evidence dir gone (worktree torn down) → permanent-failed, no publish attempted", async () => {
    const { deps, store, enqueue, evidenceDir, setNow } = setup();
    rmSync(evidenceDir, { recursive: true, force: true });
    const job = enqueue();
    setNow(2400);
    await flushEvidenceUploads(deps);
    expect(publish).not.toHaveBeenCalled();
    expect(store.getEvidenceUpload(job.id)!.permanentFailedAt).not.toBeNull();
  });
});

// The evidence_publish LEDGER kind (v30 cutover) — the live path the CLI enqueues onto. Same fake
// publisher (the module mock intercepts the kind's createEvidencePublisher import), driven through
// the generic kernel instead of the legacy flow.
import { flushOutbox } from "../src/core/outbox.ts";
import { ledgerFlow } from "../src/core/ledger.ts";
import { evidencePublishKind, EVIDENCE_PUBLISH_LEASE_SECONDS } from "../src/intents/kinds/evidence-publish.ts";
import { MIGRATIONS, migrate } from "../src/db/migrate.ts";
import { DatabaseSync } from "node:sqlite";

describe("evidence_publish intent kind (the ledger cutover)", () => {
  const enqueueIntent = (store: Store, runId: number, dir: string, prefix = "p/A", now = 2000) =>
    store.enqueueIntent({
      repo: "r",
      kind: "evidence_publish",
      scope: `run:${runId}`,
      runId,
      ticketKey: "K-EV",
      dedupKey: prefix,
      payload: JSON.stringify({ keyPrefix: prefix, evidenceDir: dir }),
      causeScope: "publisher:s3",
      leaseUntil: now + EVIDENCE_PUBLISH_LEASE_SECONDS,
      supersedeScope: true,
    });

  it("the inline lease holds the flush off; past it, a publish delivers + records the event", async () => {
    const { deps, store, run, evidenceDir, setNow } = setup();
    const job = enqueueIntent(store, run.id, evidenceDir);
    publish.mockResolvedValue({ files: ["shot.png"], urls: ["u"] });
    await flushOutbox(deps, ledgerFlow(deps)); // leased — must not be claimed
    expect(publish).not.toHaveBeenCalled();
    setNow(2000 + EVIDENCE_PUBLISH_LEASE_SECONDS + 1);
    await flushOutbox(deps, ledgerFlow(deps));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.getIntent(job.id)!.status).toBe("delivered");
    const events = store.timeline("r", "K-EV").filter((e) => e.type === "evidence_uploaded");
    expect(events.length).toBe(1);
  });

  it("auth failure → retry + SSO notify; creds recovery prePass requeues due-now and it lands", async () => {
    const { deps, store, run, evidenceDir, notify, setNow } = setup();
    const job = enqueueIntent(store, run.id, evidenceDir);
    setNow(2400);
    publish.mockRejectedValueOnce(authErr());
    await flushOutbox(deps, ledgerFlow(deps));
    const stuck = store.getIntent(job.id)!;
    expect(stuck.status).toBe("pending");
    expect(stuck.errorClass).toBe("auth");
    expect(store.authStuckIntents("r", "evidence_publish")).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("AWS SSO expired");
    // Creds come back: the prePass probe requeues the auth-stuck row and THIS pass uploads it —
    // even though its backoff (60s) hasn't elapsed at 2401.
    setNow(2401);
    probeLiveness.mockResolvedValue({ auth: false });
    publish.mockResolvedValueOnce({ files: ["shot.png"], urls: ["u"] });
    await flushOutbox(deps, ledgerFlow(deps));
    expect(store.getIntent(job.id)!.status).toBe("delivered");
  });

  it("a vanished evidence dir is terminal; a permanent config error fails + notifies + records the event", async () => {
    const { deps, store, run, evidenceDir, notify, setNow } = setup();
    const gone = enqueueIntent(store, run.id, join(tmpdir(), "nonexistent-ev-dir"), "p/GONE");
    setNow(2400);
    await flushOutbox(deps, ledgerFlow(deps));
    expect(store.getIntent(gone.id)!.status).toBe("failed");
    const perm = enqueueIntent(store, run.id, evidenceDir, "p/PERM", 2400);
    setNow(2400 + EVIDENCE_PUBLISH_LEASE_SECONDS + 1);
    publish.mockRejectedValueOnce(permErr());
    await flushOutbox(deps, ledgerFlow(deps));
    expect(store.getIntent(perm.id)!.status).toBe("failed");
    expect(notify.mock.calls.some(([t]) => String(t).includes("evidence publish failed"))).toBe(true);
    expect(store.timeline("r", "K-EV").filter((e) => e.type === "evidence_upload_failed").length).toBe(1);
  });

  it("a re-capture (different prefix) supersedes the run's earlier undelivered publish", async () => {
    const { store, run, evidenceDir } = setup();
    const first = enqueueIntent(store, run.id, evidenceDir, "p/OLD");
    const second = enqueueIntent(store, run.id, evidenceDir, "p/NEW");
    expect(store.getIntent(first.id)!.status).toBe("superseded");
    expect(store.getIntent(second.id)!.status).toBe("pending");
  });

  it("migration v30 converts pending evidence_uploads rows (clocks intact) and closes the old ones", () => {
    const db = new DatabaseSync(":memory:");
    // Build a REAL pre-v30 database by applying the chain up to v29, then seed a run + two old
    // rows: one auth-stuck mid-backoff (the state that must survive conversion exactly), one
    // already delivered (must NOT convert).
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 29)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    }
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-1','running',1,1)").run();
    db.prepare(
      `INSERT INTO evidence_uploads (run_id, repo, ticket_key, key_prefix, evidence_dir, attempts, next_attempt_at, last_error, error_kind, notified_at, created_at, updated_at)
       VALUES (1, 'r', 'K-1', 'p/A', '/wt/ev', 3, 5000, 'sso expired', 'auth', 4000, 100, 100)`,
    ).run();
    db.prepare(
      `INSERT INTO evidence_uploads (run_id, repo, ticket_key, key_prefix, evidence_dir, attempts, next_attempt_at, created_at, updated_at, delivered_at)
       VALUES (1, 'r', 'K-1', 'p/DONE', '/wt/ev', 0, 100, 100, 100, 200)`,
    ).run();
    migrate(db);
    const converted = db.prepare("SELECT * FROM intents WHERE kind = 'evidence_publish'").all() as Record<string, unknown>[];
    expect(converted.length).toBe(1); // the delivered row did not convert
    expect(converted[0]).toMatchObject({
      scope: "run:1",
      dedup_key: "p/A",
      status: "pending",
      attempts: 3,
      next_attempt_at: 5000,
      error_class: "auth",
      cause_scope: "publisher:s3",
      notified_at: 4000,
    });
    expect(JSON.parse(converted[0]!.payload as string)).toEqual({ keyPrefix: "p/A", evidenceDir: "/wt/ev" });
    expect((converted[0]!.seq as number) > 0).toBe(true);
    // The old pending row is closed so a draining old-code flush finds nothing due.
    const old = db.prepare("SELECT abandoned_at FROM evidence_uploads WHERE key_prefix = 'p/A'").get() as { abandoned_at: number | null };
    expect(old.abandoned_at).not.toBeNull();
  });
});
