// Health checks, shared by the `doctor` CLI command (prints ✓/✗) and the TUI Doctor tab (renders
// ✓/✗). Each check returns a structured result so both consumers render it however they like — the
// check logic lives in exactly one place. Grouped by ownership: what herdr-factory provisions &
// maintains itself vs the external tools + auth the user supplies. Repo-specific checks are a
// separate group behind `--repo`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./clients/exec.ts";
import { assertMainCheckout, globalDbPath, isManagedNode } from "./config.ts";
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

/** Machine-wide checks, grouped by ownership. No repo needed. */
export async function baseGroups(): Promise<DoctorGroup[]> {
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

  const provided = await Promise.all([
    attempt("git", async () => void (await run("git", ["--version"]))),
    attempt("herdr", async () => void (await run(herdrBin, ["workspace", "list"]))),
    attempt("gh (authenticated)", async () => void (await run("gh", ["auth", "status"]))),
    attempt("claude", async () => void (await run("claude", ["--version"]))),
  ]);

  return [
    { title: "managed by herdr-factory", checks: managed },
    { title: "you provide (install + auth)", checks: provided },
  ];
}

/** Repo-specific checks: config validity, the repo checkout, origin, each work source's health, and
 *  Jira auth. A config-load failure is a ✗ (not a throw), so the caller can still show the base
 *  groups. Evidence is reported as an always-ok info line (it's optional). */
export async function repoGroup(repo: string): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  let deps: Deps | undefined;
  checks.push(
    await attempt("config loads + valid", async () => {
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
      checks.push(await attempt(`source ${src.name} (${src.type})`, async () => void (await src.client.health())));
      if (src.type === "jira") {
        checks.push(
          await attempt(`jira auth for ${src.name}`, async () => {
            if (!d.secrets.jiraEmail || !d.secrets.jiraApiToken) throw new Error("JIRA_EMAIL / JIRA_API_TOKEN missing in the repo env file");
          }),
        );
      }
    }
    const ev = d.config.evidence;
    checks.push({ name: "evidence", ok: true, detail: ev ? `s3://${ev.bucket} (${ev.region}) → ${ev.cloudfrontDomain}` : "not configured" });
  }
  return { title: `repo ${repo}`, checks };
}
