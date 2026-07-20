import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidencePublisher } from "../src/clients/evidence.ts";
import { flushEvidenceUploads } from "../src/core/reconcile.ts";
import { createApp, type ServerContext } from "../src/server/app.ts";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import type { Deps } from "../src/core/deps.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ev-pub-"));
  process.env.HERDR_FACTORY_STATE_ROOT = join(base, "state");
  process.env.HERDR_FACTORY_PORT = "8765";
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  delete process.env.HERDR_FACTORY_STATE_ROOT;
  delete process.env.HERDR_FACTORY_PORT;
});

/** Write an executable stub script and return its path. */
function stub(name: string, body: string): string {
  const p = join(base, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A capture dir with one nested tree of files. */
function captureDir(): string {
  const dir = join(base, "capture");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "shot.png"), "PNG-BYTES");
  writeFileSync(join(dir, "sub", "clip.mp4"), "MP4-BYTES");
  return dir;
}

describe("s3 publisher", () => {
  const ev = { publisher: "s3" as const, bucket: "b", region: "us-east-1", cloudfrontDomain: "d.cf.net", keyPrefix: "" };
  it("predicts the CloudFront URLs up-front (prefix + filename, nested paths encoded segment-wise)", () => {
    const p = createEvidencePublisher(ev);
    expect(p.kind).toBe("s3");
    expect(p.predictUrls("herdr-factory/alice/HF-1/5-t", ["shot.png", "sub/clip.mp4"])).toEqual([
      "https://d.cf.net/herdr-factory/alice/HF-1/5-t/shot.png",
      "https://d.cf.net/herdr-factory/alice/HF-1/5-t/sub/clip.mp4",
    ]);
  });
  it("carries the creds/SSO liveness probe (the only publisher that does)", () => {
    expect(typeof createEvidencePublisher(ev).probeLiveness).toBe("function");
  });
});

describe("local publisher", () => {
  it("predicts server URLs — loopback by default, the configured origin when set", () => {
    const dflt = createEvidencePublisher({ publisher: "local", keyPrefix: "" });
    expect(dflt.kind).toBe("local");
    expect(dflt.probeLiveness).toBeUndefined(); // no auth → no SSO light
    expect(dflt.predictUrls("pre/fix", ["shot.png"])).toEqual(["http://127.0.0.1:8765/evidence/pre/fix/shot.png"]);

    const custom = createEvidencePublisher({ publisher: "local", publicBaseUrl: "https://box.tailnet.ts.net", keyPrefix: "" });
    expect(custom.predictUrls("pre/fix", ["sub/clip.mp4"])).toEqual(["https://box.tailnet.ts.net/evidence/pre/fix/sub/clip.mp4"]);
  });

  it("publishes by copying the capture tree into the server's serve dir under the prefix", async () => {
    const p = createEvidencePublisher({ publisher: "local", keyPrefix: "" });
    const { files, urls } = await p.publish({ dir: captureDir(), prefix: "herdr-factory/HF-1/5-t" });
    expect(files).toEqual(["shot.png", "sub/clip.mp4"]);
    expect(urls).toEqual([
      "http://127.0.0.1:8765/evidence/herdr-factory/HF-1/5-t/shot.png",
      "http://127.0.0.1:8765/evidence/herdr-factory/HF-1/5-t/sub/clip.mp4",
    ]);
    const served = join(process.env.HERDR_FACTORY_STATE_ROOT!, "evidence", "herdr-factory/HF-1/5-t");
    expect(readFileSync(join(served, "shot.png"), "utf8")).toBe("PNG-BYTES");
    expect(readFileSync(join(served, "sub", "clip.mp4"), "utf8")).toBe("MP4-BYTES");
  });
});

describe("command publisher", () => {
  const cfg = (command: string[], timeoutSeconds = 30) => ({ publisher: "command" as const, command, timeoutSeconds, keyPrefix: "" });
  // A backend stub: receives (captureDir, keyPrefix), prints one URL per file to stdout.
  const okStub = () => stub("ok.sh", 'cd "$1" || exit 2\nfind . -type f | sed "s|^\\./||" | sort | while read f; do echo "https://cdn.example/$2/$f"; done');

  it("has no up-front URLs (they come only from the command's stdout)", () => {
    expect(createEvidencePublisher(cfg([okStub()])).predictUrls("pre", ["a.png"])).toBeNull();
  });

  it("publishes by running the command + parsing its stdout URLs (ignoring log noise)", async () => {
    const noisy = stub("noisy.sh", 'echo "uploading…"\ncd "$1" || exit 2\nfind . -type f | sed "s|^\\./||" | sort | while read f; do echo "https://cdn.example/$2/$f"; done\necho "done"');
    const p = createEvidencePublisher(cfg([noisy]));
    const { files, urls } = await p.publish({ dir: captureDir(), prefix: "HF-1/5-t" });
    expect(files).toEqual(["shot.png", "sub/clip.mp4"]);
    expect(urls).toEqual(["https://cdn.example/HF-1/5-t/shot.png", "https://cdn.example/HF-1/5-t/sub/clip.mp4"]);
  });

  it("a non-zero exit throws → classifyError is transient (retryable, no SSO light)", async () => {
    const fail = stub("fail.sh", 'echo "backend unreachable" >&2\nexit 1');
    const p = createEvidencePublisher(cfg([fail]));
    const err = await p.publish({ dir: captureDir(), prefix: "HF-1/5-t" }).then(() => null).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const c = p.classifyError(err);
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });

  it("throws when the command prints no URLs (contract: one per file)", async () => {
    const silent = stub("silent.sh", 'echo "uploaded, but forgot to print links"\nexit 0');
    const p = createEvidencePublisher(cfg([silent]));
    await expect(p.publish({ dir: captureDir(), prefix: "HF-1/5-t" })).rejects.toThrow(/no URLs/i);
  });

  it("deepProbe runs the command against a throwaway file and reports the URL", async () => {
    const detail = await createEvidencePublisher(cfg([okStub()])).deepProbe();
    expect(detail).toMatch(/command ran — printed 1 URL/);
    expect(detail).toContain("https://cdn.example/");
  });
});

// ── the outbox retries a command failure with the same backoff/notify semantics as S3 ──
describe("evidence outbox with a real command publisher", () => {
  function setup(command: string[]) {
    let now = 2000;
    const store = new Store(openDb(":memory:"), () => now);
    const notify = vi.fn(async () => {});
    const deps = {
      config: { repoName: "r", evidence: { publisher: "command", command, timeoutSeconds: 30, keyPrefix: "" }, limits: { attentionRenotifySeconds: 3600 } },
      store,
      herdr: { notify },
      github: { currentLogin: async () => null },
      log: () => {},
      now: () => now,
    } as unknown as Deps;
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-EV", branch: "fix/K-EV" });
    const job = store.enqueueEvidenceUpload({ runId: run.id, repo: "r", ticketKey: "K-EV", keyPrefix: "HF-1/5-t", evidenceDir: captureDir() });
    return { deps, store, job, setNow: (n: number) => { now = n; } };
  }

  it("failure → deferred (transient), retried after backoff (NOT permanent-failed)", async () => {
    const fail = stub("fail.sh", 'echo "backend down" >&2\nexit 1');
    const { deps, store, job, setNow } = setup([fail]);
    setNow(2400); // past the enqueue lease
    await flushEvidenceUploads(deps);
    const row = store.getEvidenceUpload(job.id)!;
    expect(row.deliveredAt).toBeNull();
    expect(row.permanentFailedAt).toBeNull(); // transient — keeps retrying
    expect(row.errorKind).toBe("transient");
    expect(row.attempts).toBe(1);
    // Still inside the 60s backoff → not due; past it → due again (the retry).
    expect(store.dueEvidenceUploads("r")).toHaveLength(0);
    setNow(2400 + 61);
    expect(store.dueEvidenceUploads("r")).toHaveLength(1);
  });

  it("success → delivered + evidence_uploaded event", async () => {
    const ok = stub("ok.sh", 'cd "$1" || exit 2\nfind . -type f | sed "s|^\\./||" | sort | while read f; do echo "https://cdn.example/$2/$f"; done');
    const { deps, store, job, setNow } = setup([ok]);
    setNow(2400);
    await flushEvidenceUploads(deps);
    expect(store.getEvidenceUpload(job.id)!.deliveredAt).not.toBeNull();
    expect(store.timeline("r", "K-EV").some((e) => e.type === "evidence_uploaded")).toBe(true);
  });
});

// ── the resident server serves `local` captures (with a path-traversal guard) ──
describe("server /evidence/* static serve", () => {
  const app = () => createApp({ getRepo: () => undefined, knownRepos: () => [] } as unknown as ServerContext);

  function seed(): void {
    const dir = join(process.env.HERDR_FACTORY_STATE_ROOT!, "evidence", "herdr-factory/alice/HF-1/5-t");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shot.png"), "PNG-BYTES");
  }

  it("serves a copied capture with its content-type", async () => {
    seed();
    const res = await app().request("/evidence/herdr-factory/alice/HF-1/5-t/shot.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("PNG-BYTES");
  });

  it("404s a missing file", async () => {
    const res = await app().request("/evidence/herdr-factory/alice/HF-1/5-t/missing.png");
    expect(res.status).toBe(404);
  });

  it("refuses path traversal (encoded or literal) instead of escaping the serve root", async () => {
    seed();
    for (const p of ["/evidence/..%2f..%2f..%2fetc/passwd", "/evidence/herdr-factory/../../../etc/passwd", "/evidence/%2e%2e/%2e%2e/secret"]) {
      const res = await app().request(p);
      expect(res.status).toBe(404);
    }
  });
});
