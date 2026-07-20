// `herdr-factory init` — scaffolding a repo config from inside a checkout. Uses a REAL temp git repo
// (so origin resolution + assertMainCheckout run against actual git), and validates every rendered
// scaffold both structurally (RepoConfigSchema) and end-to-end (loadConfig).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { initRepo, renderConfigYaml } from "../src/init.ts";
import { RepoConfigSchema, loadConfig } from "../src/config.ts";
import type { SourceType } from "../src/types.ts";
import { run } from "../src/clients/exec.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_FACTORY_CONFIG_DIR;
  delete process.env.HERDR_FACTORY_STATE_ROOT;
});

/** A temp dir that's a real git checkout (main, .git is a dir) with an optional origin remote, plus
 *  a fresh config dir wired via the env overrides. Returns the repo path + config dir. */
async function scaffoldEnv(opts: { origin?: string } = {}): Promise<{ repoPath: string; configDir: string }> {
  const base = mkdtempSync(join(tmpdir(), "init-test-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const repoPath = join(base, "project");
  mkdirSync(repoPath, { recursive: true });
  await run("git", ["-C", repoPath, "init", "-q"]);
  if (opts.origin) await run("git", ["-C", repoPath, "remote", "add", "origin", opts.origin]);
  const configDir = join(base, "cfg");
  process.env.HERDR_FACTORY_CONFIG_DIR = configDir;
  process.env.HERDR_FACTORY_STATE_ROOT = join(base, "state");
  return { repoPath, configDir };
}

const ALL_SOURCES: SourceType[] = ["jira", "github_issues", "local_markdown", "sentry"];

describe("renderConfigYaml — every source scaffold is a structurally valid config", () => {
  for (const source of ALL_SOURCES) {
    it(`renders a valid ${source} config (with and without a resolved origin)`, () => {
      for (const ghRepo of ["acme/widget", null] as const) {
        const yaml = renderConfigYaml({ repoPath: "/home/me/project", repoName: "project", source, ghRepo });
        const parsed = RepoConfigSchema.safeParse(parseYaml(yaml));
        expect(parsed.success, `${source}/${ghRepo}: ${parsed.success ? "" : JSON.stringify(parsed.error?.issues)}`).toBe(true);
        // The schema modeline must be the first line so editors pick it up.
        expect(yaml.split("\n")[0]).toBe("# yaml-language-server: $schema=../../config.schema.json");
      }
    });
  }

  it("shortens a home-dir repo path to ~ (and omits label for label-less sources)", () => {
    const yaml = renderConfigYaml({ repoPath: join(process.env.HOME ?? "/home/me", "dev/app"), repoName: "app", source: "local_markdown", ghRepo: null });
    expect(yaml).toContain("path: ~/dev/app");
    expect(yaml).not.toContain("label:"); // local_markdown has no label concept
  });

  it("includes the pickup label for a label-driven source", () => {
    const yaml = renderConfigYaml({ repoPath: "/x", repoName: "x", source: "github_issues", ghRepo: "acme/widget" });
    expect(yaml).toContain("label: agent");
  });
});

describe("initRepo — from inside a checkout", () => {
  it("defaults to github_issues when the origin resolves, writing config + schema (no env)", async () => {
    const { repoPath, configDir } = await scaffoldEnv({ origin: "git@github.com:acme/widget.git" });
    const res = await initRepo({ cwd: repoPath });
    expect(res.source).toBe("github_issues");
    expect(res.ghRepo).toBe("acme/widget");
    expect(res.repoName).toBe(basename(repoPath));
    expect(existsSync(res.configPath)).toBe(true);
    expect(res.configPath).toBe(join(configDir, "repos", res.repoName, "config.yml"));
    expect(existsSync(res.schemaPath)).toBe(true);
    // github_issues needs no credentials — no env scaffold.
    expect(res.envPath).toBeUndefined();
    expect(res.secretKeys).toEqual([]);
    // The origin flows into the source block as a derivation note.
    expect(readFileSync(res.configPath, "utf8")).toContain("acme/widget");
    // And it loads end-to-end (not just schema-valid). repo.path is the git top-level init resolved
    // (macOS resolves /var → /private/var, so compare against what init recorded, not the raw temp path).
    const { config } = loadConfig(res.repoName);
    expect(config.repo.path).toBe(res.repoPath);
    expect(config.belts[0]!.source).toBe("issues");
  });

  it("defaults to local_markdown when there is no origin", async () => {
    const { repoPath } = await scaffoldEnv();
    const res = await initRepo({ cwd: repoPath });
    expect(res.source).toBe("local_markdown");
    expect(res.ghRepo).toBeNull();
    expect(loadConfig(res.repoName).config.belts[0]!.source).toBe("briefs");
  });

  it("scaffolds a fill-me env file (chmod 600, empty keys) for a credentialed source", async () => {
    const { repoPath } = await scaffoldEnv({ origin: "git@github.com:acme/widget.git" });
    const res = await initRepo({ cwd: repoPath, source: "jira" });
    expect(res.source).toBe("jira");
    expect(res.secretKeys).toEqual(["JIRA_EMAIL", "JIRA_API_TOKEN"]);
    expect(res.envPath).toBeDefined();
    const body = readFileSync(res.envPath!, "utf8");
    // Keys are present but EMPTY (so doctor flags them as missing until filled).
    expect(body).toMatch(/^JIRA_EMAIL=$/m);
    expect(body).toMatch(/^JIRA_API_TOKEN=$/m);
    expect(statSync(res.envPath!).mode & 0o777).toBe(0o600);
  });

  it("honours an explicit --repo name and --source over the defaults", async () => {
    const { repoPath, configDir } = await scaffoldEnv({ origin: "git@github.com:acme/widget.git" });
    const res = await initRepo({ cwd: repoPath, repoName: "my-app", source: "sentry" });
    expect(res.repoName).toBe("my-app");
    expect(res.source).toBe("sentry");
    expect(res.configPath).toBe(join(configDir, "repos", "my-app", "config.yml"));
    expect(res.secretKeys).toEqual(["SENTRY_AUTH_TOKEN"]);
  });

  it("refuses to overwrite an existing config.yml unless --force", async () => {
    const { repoPath } = await scaffoldEnv({ origin: "git@github.com:acme/widget.git" });
    const first = await initRepo({ cwd: repoPath });
    // Hand-edit, then re-init without force → refused, edit preserved.
    writeFileSync(first.configPath, "# hand edited\n");
    await expect(initRepo({ cwd: repoPath })).rejects.toThrow(/already exists/);
    expect(readFileSync(first.configPath, "utf8")).toBe("# hand edited\n");
    // With force → overwritten with a fresh scaffold.
    const forced = await initRepo({ cwd: repoPath, force: true });
    expect(readFileSync(forced.configPath, "utf8")).toContain("yaml-language-server");
  });

  it("preserves an existing env file rather than clobbering real credentials", async () => {
    const { repoPath, configDir } = await scaffoldEnv({ origin: "git@github.com:acme/widget.git" });
    const repoName = basename(repoPath);
    const repoDir = join(configDir, "repos", repoName);
    mkdirSync(repoDir, { recursive: true });
    const envPath = join(repoDir, "env");
    writeFileSync(envPath, "JIRA_EMAIL=me@real.com\nJIRA_API_TOKEN=secret\n");
    const res = await initRepo({ cwd: repoPath, source: "jira" });
    expect(res.envPath).toBe(envPath);
    expect(readFileSync(envPath, "utf8")).toContain("me@real.com"); // untouched
  });

  it("errors clearly when run outside a git repo and no --path is given", async () => {
    const base = mkdtempSync(join(tmpdir(), "init-nogit-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    process.env.HERDR_FACTORY_CONFIG_DIR = join(base, "cfg");
    await expect(initRepo({ cwd: base })).rejects.toThrow(/not inside a git repository/);
  });

  it("respects --path pointing at another checkout", async () => {
    const { repoPath } = await scaffoldEnv({ origin: "git@github.com:acme/widget.git" });
    const elsewhere = mkdtempSync(join(tmpdir(), "init-cwd-"));
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    const res = await initRepo({ cwd: elsewhere, path: repoPath });
    expect(res.repoPath).toBe(repoPath);
    expect(res.ghRepo).toBe("acme/widget");
  });
});
