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
