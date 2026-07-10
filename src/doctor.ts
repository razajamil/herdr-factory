// Health checks, shared by the `doctor` CLI command (prints ✓/✗) and the TUI Doctor tab (renders
// ✓/✗). Each check returns a structured result so both consumers render it however they like — the
// check logic lives in exactly one place. Grouped by ownership: what herdr-factory provisions &
// maintains itself vs the external tools + auth the user supplies. Repo-specific checks are a
// separate group behind `--repo`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { classifyS3Error } from "./clients/evidence.ts";
import { run } from "./clients/exec.ts";
import { assertMainCheckout, globalDbPath, isManagedNode } from "./config.ts";
import { descriptorFor } from "./sources/registry.ts";
import { buildDeps } from "./build-deps.ts";
import type { Deps } from "./core/deps.ts";
import { pingHealth, readServerInfo } from "./server/client.ts";
import * as service from "./watchers/service.ts";

/** One check's outcome. `detail` is extra context: a version/path/endpoint on success, or the
 *  failure reason on ✗. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface DoctorGroup {
  title: string;
  checks: DoctorCheck[];
}

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Run one check: the fn returns a success `detail` string (or void) or throws — a thrown Error's
 *  message becomes the ✗ detail. Never rejects. */
async function attempt(name: string, fn: () => Promise<string | void>): Promise<DoctorCheck> {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail || undefined };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error && e.message ? e.message : undefined };
  }
}

/** Is a tool on PATH? Presence only — doesn't invoke it (so no network/side effects). Resolves
 *  against `env` (the server's PATH) when given, so the answer doesn't depend on how THIS process
 *  was launched — a GUI-opened TUI has a leaner PATH than a terminal, but both should report the
 *  environment where the factory actually runs its tools. */
async function onPath(tool: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await run("sh", ["-c", `command -v ${JSON.stringify(tool)} >/dev/null 2>&1`], { env });
}

/** Machine-wide checks, grouped by ownership. No repo needed.
 *  `deep` = also interact with external services (gh auth, herdr daemon); the default is local-only
 *  and side-effect-free (tool presence, no network calls). */
export async function baseGroups(deep = false): Promise<DoctorGroup[]> {
  const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
  const info = readServerInfo();
  const running = info ? await pingHealth(info.port).catch(() => false) : false;

  const managed = await Promise.all([
    attempt("node runtime >= 26", async () => {
      if (Number(process.versions.node.split(".")[0]) < 26) throw new Error(`v${process.versions.node} is too old`);
      return `v${process.versions.node}, ${isManagedNode(process.execPath) ? "vendored" : "ambient"}`;
    }),
    attempt("auto-update", async () => `upstream ${(await run("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: PKG_ROOT })).stdout.trim()}`),
    attempt("supervisor service", async () => {
      if (!(await service.isLoaded())) throw new Error("not loaded — run `herdr-factory install`");
    }),
    attempt("server", async () => {
      if (!running) throw new Error(info ? "registered but not responding" : "not running (run `herdr-factory start`)");
      return `running on :${info!.port} (v${info!.version})`;
    }),
    attempt("database", async () => {
      const p = globalDbPath();
      if (!existsSync(p)) throw new Error("not initialized yet (created on the first `serve`)");
      return p;
    }),
  ]);

  // These tools are resolved against the SERVICE's PATH, not this process's. The checks run
  // in-process (CLI command or TUI tab), but the tools are found/invoked by the resident `serve`,
  // which runs with the PATH baked into the launchd plist / systemd unit at install. A terminal has
  // that rich PATH; a GUI-launched TUI inherits the bare `/usr/bin:/bin:…` and would otherwise
  // report herdr/gh/claude as "missing" while `serve` finds them fine (git survives only via its
  // /usr/bin fallback). Falling back to process.env when the service isn't installed keeps the old
  // behavior (and the "supervisor service" check above already flags a missing service).
  // Default: presence on PATH (local, no network). Deep: actually interact (gh auth verifies the
  // GitHub token; herdr `workspace list` verifies the daemon responds).
  const toolPath = service.servicePath();
  const toolEnv = toolPath ? { ...process.env, PATH: toolPath } : undefined;
  const provided = await Promise.all([
    attempt("git", () => onPath("git", toolEnv)),
    deep
      ? attempt("herdr (daemon responds)", async () => void (await run(herdrBin, ["workspace", "list"], { env: toolEnv })))
      : attempt("herdr", () => onPath(herdrBin, toolEnv)),
    deep
      ? attempt("gh (authenticated)", async () => void (await run("gh", ["auth", "status"], { env: toolEnv })))
      : attempt("gh", () => onPath("gh", toolEnv)),
    attempt("claude", () => onPath("claude", toolEnv)),
  ]);

  return [
    { title: "managed by herdr-factory", checks: managed },
    { title: "you provide (install + auth)", checks: provided },
  ];
}

/** Repo-specific checks: config validity, the repo checkout, origin, work sources, and evidence.
 *  A config-load failure is a ✗ (not a throw), so the caller can still show the base groups.
 *  `deep` = also interact with services (work-source health endpoints, an evidence-bucket write
 *  probe); the default only inspects local config. */
export async function repoGroup(repo: string, deep = false): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  let deps: Deps | undefined;
  checks.push(
    // Naming matters: buildDeps also CONSTRUCTS each source client, and a descriptor's create()
    // may throw on an unbuildable source (e.g. github_issues with no resolvable repo) even when
    // the YAML itself is schema-valid — the label must not send the operator to the config file.
    await attempt("config loads + sources buildable", async () => {
      deps = await buildDeps(repo);
    }),
  );
  if (deps) {
    const d = deps;
    checks.push(await attempt("repo.path is a main git checkout", async () => assertMainCheckout(d.config.repo.path)));
    checks.push(
      await attempt("git origin resolved", async () => {
        if (!d.ghRepo) throw new Error("no origin — set repo.github or add a git remote");
        return d.ghRepo;
      }),
    );
    for (const src of d.sources) {
      // The pickup labels of every belt feeding this source (deduped) — a label-driven source
      // health-checks each one is usable; a label-less source ignores them.
      const pickupLabels = [...new Set(d.belts.filter((b) => b.source === src.name).map((b) => b.label).filter((l): l is string => !!l))];
      // Default: it's configured (local). Deep: hit the backend's health endpoint (network).
      if (deep) {
        checks.push(await attempt(`source ${src.name} (${src.type})`, async () => void (await src.client.health(pickupLabels))));
      } else {
        checks.push({ name: `source ${src.name} (${src.type})`, ok: true, detail: "configured (--deep to health-check)" });
      }
      // Auth readiness — the source's own cheap, no-network view (INV-12). Covers what the secrets
      // manifest can't (github's `gh auth token` fallback), and reads back the actionable hint. A
      // present-but-rejected credential still shows ✓ here; deep's health() is what exercises it.
      checks.push(
        await attempt(`auth ${src.name} (${src.type})`, async () => {
          const st = await src.client.authStatus();
          if (st.state === "unauthenticated") throw new Error(st.detail ?? "not authenticated");
          return st.state === "not_applicable" ? "no auth required" : "credentials present";
        }),
      );
      // Required secrets present is a cheap local check (driven by the type's descriptor
      // manifest) — keep in both modes; deep's health() proves they actually work.
      const required = descriptorFor(src.type).secrets.filter((s) => s.required);
      if (required.length > 0) {
        checks.push(
          await attempt(`${src.type} secrets for ${src.name}`, async () => {
            const missing = required.filter((s) => !d.env[s.envKey]);
            if (missing.length > 0) {
              throw new Error(missing.map((s) => `${s.envKey} missing in the repo env file — ${s.hint}`).join("; "));
            }
          }),
        );
      }
    }
    const ev = d.config.evidence;
    // Default: report it's configured (local). Deep: PutObject write-probe (network + a tiny S3 write).
    // Uploads land under herdr-factory/<github_username>/<key_prefix>/… ; show that base.
    if (!ev) {
      checks.push({ name: "evidence", ok: true, detail: "not configured (optional)" });
    } else if (deep) {
      // Resolve the real per-user folder (override, else gh login) so the probe writes where uploads do.
      const username = ev.githubUsername ?? (await d.github.currentLogin()) ?? undefined;
      checks.push(await attempt(`evidence bucket (s3://${ev.bucket})`, () => probeEvidenceBucket(ev, username)));
    } else {
      // Shallow = no network, so show the override or a <gh-login> placeholder rather than resolving it.
      const folder = ["herdr-factory", ev.githubUsername ?? "<gh-login>", ev.keyPrefix].filter(Boolean).join("/");
      checks.push({ name: "evidence", ok: true, detail: `configured: s3://${ev.bucket}/${folder}/ (${ev.region}) — --deep to write-probe` });
    }
    // Evidence-upload outbox health (local, no network): pending uploads still retrying. An auth-class
    // stuck upload almost always means the AWS SSO session expired — the actionable fix.
    if (ev) {
      const pending = d.store.pendingEvidenceUploads(repo);
      if (pending.length === 0) {
        checks.push({ name: "evidence uploads", ok: true, detail: "none pending" });
      } else if (pending.some((u) => u.errorKind === "auth")) {
        checks.push({ name: "evidence uploads", ok: false, detail: `${pending.length} stuck — AWS SSO/creds expired; run \`aws sso login${ev.profile ? ` --profile ${ev.profile}` : ""}\`` });
      } else {
        checks.push({ name: "evidence uploads", ok: true, detail: `${pending.length} pending — retrying (last: ${pending[pending.length - 1]!.lastError ?? "not yet attempted"})` });
      }
    }
  }
  return { title: `repo ${repo}`, checks };
}

/** Verify the evidence upload can actually reach AND write the bucket: PUT a 0-byte probe object at
 *  the real upload base `herdr-factory/<github_username>/<key_prefix>/.herdr-doctor` (a fixed key,
 *  overwritten each run so nothing accumulates) using the SAME ambient credential chain the real
 *  upload uses. This exercises the exact s3:PutObject permission at the exact prefix uploads land in
 *  — not just reachability. Returns a success detail or throws a concise, actionable reason.
 *  NOTE: this writes one tiny object to the bucket (by design). */
async function probeEvidenceBucket(ev: NonNullable<Deps["config"]["evidence"]>, username?: string): Promise<string> {
  // Silence the SDK's own console warnings (ambient-credential-source notes, body-length hints) so
  // they don't leak into the doctor output — the check reports the outcome itself.
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const s3 = new S3Client({
    region: ev.region,
    maxAttempts: 1, // a doctor should fail fast, not retry a broken config for ~20s
    logger: silent,
    ...(ev.profile ? { credentials: fromNodeProviderChain({ profile: ev.profile, logger: silent }) } : {}),
  });
  const key = ["herdr-factory", username, ev.keyPrefix, ".herdr-doctor"].filter(Boolean).join("/");
  try {
    // A short known-length body (avoids the SDK's "stream of unknown length" PutObject warning).
    await s3.send(new PutObjectCommand({ Bucket: ev.bucket, Key: key, Body: "herdr-factory doctor probe\n", ContentType: "text/plain" }), {
      abortSignal: AbortSignal.timeout(8000),
    });
    return `writable — wrote s3://${ev.bucket}/${key} (${ev.region})`;
  } catch (e) {
    throw new Error(explainS3Error(e));
  } finally {
    s3.destroy();
  }
}

/** Map an AWS SDK error to a short, actionable doctor reason. Delegates to the shared classifier so the
 *  S3 taxonomy lives in exactly one place (src/clients/evidence.ts). */
function explainS3Error(e: unknown): string {
  return classifyS3Error(e).reason;
}
