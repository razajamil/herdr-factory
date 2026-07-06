// Evidence media upload to S3 + CloudFront, shared by the `evidence-upload` CLI command (agent-driven,
// inline fast path) and the reconciler's Phase 0 flush (durable background retry). The AWS logic lives
// here in ONE place so both callers agree on the key layout, the URL shape, and — crucially — how an
// SDK error is classified: an expired AWS SSO session must be a RETRYABLE `auth` failure the outbox
// keeps retrying (and the dashboard shows red), never a hard failure that drops the evidence (the
// PR #6541 bug). Non-secret infra pointers come from `config.evidence`; credentials come from the
// ambient AWS chain (env / SSO / ~/.aws / the named `profile`), never stored or logged.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { lookup as mimeLookup } from "mime-types";
import type { Config } from "../config.ts";

export type EvidenceConfig = NonNullable<Config["evidence"]>;

/** The kind of an S3/AWS failure — decides retry policy and the dashboard SSO light:
 *  - `auth`      → creds/SSO token expired or unresolved. Retryable (after `aws sso login`); this is
 *                  the ONLY kind that means "SSO down".
 *  - `permanent` → config error (no bucket / wrong region / access denied). Retrying can't help; stop + surface.
 *  - `transient` → timeout / unknown. Retryable with backoff. */
export type S3ErrorKind = "auth" | "transient" | "permanent";

export interface S3Classification {
  kind: S3ErrorKind;
  retryable: boolean;
  reason: string;
}

/** Map an AWS SDK error to a kind + a short, actionable reason (the single source of truth for the S3
 *  taxonomy — `doctor.explainS3Error` delegates to `.reason`). */
export function classifyS3Error(e: unknown): S3Classification {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = err.name ?? "";
  const status = err.$metadata?.httpStatusCode;
  const msg = err.message ?? String(e);
  if (/Credential|Token|SSO|ExpiredToken/i.test(name) || /could not load credentials|credential|sso session|token.*expired|expired.*token/i.test(msg)) {
    return { kind: "auth", retryable: true, reason: "AWS SSO/credentials expired or unresolved — run `aws sso login`" };
  }
  if (name === "NoSuchBucket") return { kind: "permanent", retryable: false, reason: "bucket does not exist" };
  if (name === "PermanentRedirect" || /AuthorizationHeaderMalformed|the bucket is in this region|expecting.*region/i.test(msg)) {
    return { kind: "permanent", retryable: false, reason: "wrong region — the bucket is in a different AWS region" };
  }
  if (status === 403 || /AccessDenied|Forbidden/i.test(name)) {
    return { kind: "permanent", retryable: false, reason: "access denied — credentials lack s3:PutObject on this bucket/prefix" };
  }
  if (/Timeout|Abort/i.test(name) || /timed out|aborted/i.test(msg)) return { kind: "transient", retryable: true, reason: "timed out reaching S3" };
  return { kind: "transient", retryable: true, reason: `${name || "error"}: ${msg}`.slice(0, 160) };
}

/** Build an S3 client for an evidence bucket. `maxAttempts:1` so callers own retry/backoff (the outbox),
 *  and the SDK's own console chatter is silenced. */
function evidenceClient(ev: EvidenceConfig): S3Client {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  return new S3Client({
    region: ev.region,
    maxAttempts: 1,
    logger: silent,
    ...(ev.profile ? { credentials: fromNodeProviderChain({ profile: ev.profile, logger: silent }) } : {}),
  });
}

/** Enumerate the evidence dir RECURSIVELY as posix-normalized relative paths (files only, sorted) — the
 *  set of assets to upload / build URLs for. The dir is frozen once the evidence agent finishes, so this
 *  is deterministic across the inline attempt and every retry. */
export function enumerateEvidenceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .map((r) => r.split(sep).join("/"))
    .filter((r) => {
      try {
        return statSync(join(dir, r)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** The public CloudFront URL per file (each ends with its filename, so callers can bind it to the right
 *  evidence row). Deterministic from the prefix + filenames — computable without the upload succeeding. */
export function evidenceUrls(cloudfrontDomain: string, prefix: string, files: string[]): string[] {
  return files.map((f) => `https://${cloudfrontDomain}/${prefix}/${f.split("/").map(encodeURIComponent).join("/")}`);
}

/** Upload every file under `dir` to `s3://<bucket>/<prefix>/…` (re-enumerated here so it always matches
 *  the frozen dir). Throws the raw SDK error on failure (caller classifies via `classifyS3Error`).
 *  Multipart is automatic for large video. Idempotent per key, so a retry (or a lease-overrun double
 *  upload) just overwrites. */
export async function uploadEvidence(opts: { evidence: EvidenceConfig; dir: string; prefix: string }): Promise<{ files: string[] }> {
  const { evidence: ev, dir, prefix } = opts;
  const files = enumerateEvidenceFiles(dir);
  const s3 = evidenceClient(ev);
  try {
    for (const rel of files) {
      await new Upload({
        client: s3,
        params: {
          Bucket: ev.bucket,
          Key: `${prefix}/${rel}`,
          Body: createReadStream(join(dir, rel)),
          // ContentType is load-bearing: without it CloudFront serves screenshots/video as downloads.
          ContentType: mimeLookup(rel) || "application/octet-stream",
        },
      }).done();
    }
    return { files };
  } finally {
    s3.destroy();
  }
}

/** Read-only credential liveness probe for the dashboard SSO light: a `HeadBucket` (no write) via the
 *  configured profile, short timeout. `auth:true` == SSO/creds down (the only "SSO is down" signal); a
 *  permanent bucket/perms error or a transient/timeout means creds are FINE (surfaced elsewhere), so the
 *  light stays green. */
export async function probeEvidenceCreds(ev: EvidenceConfig): Promise<{ auth: boolean; reason: string }> {
  const s3 = evidenceClient(ev);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: ev.bucket }), { abortSignal: AbortSignal.timeout(3000) });
    return { auth: false, reason: "ok" };
  } catch (e) {
    const c = classifyS3Error(e);
    return { auth: c.kind === "auth", reason: c.reason };
  } finally {
    s3.destroy();
  }
}

/** The per-user evidence folder segment: the config override, else the gh-authenticated login
 *  (best-effort — omitted if it can't be resolved). Callers pass `deps.github.currentLogin`. */
export async function resolveGithubUsername(ev: EvidenceConfig, currentLogin: () => Promise<string | null>): Promise<string | undefined> {
  return ev.githubUsername ?? (await currentLogin().catch(() => null)) ?? undefined;
}
