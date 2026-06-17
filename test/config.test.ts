import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, assertMainCheckout } from "../src/config.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_CATS_CONFIG_DIR;
  delete process.env.HERDR_CATS_STATE_ROOT;
});

function setup(yml: string, opts?: { guidance?: string }) {
  const base = mkdtempSync(join(tmpdir(), "cats-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const repoPath = join(base, "repo");
  mkdirSync(join(repoPath, ".git"), { recursive: true }); // main checkout: .git is a dir
  const repoDir = join(base, "cfg", "repos", "demo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "config.yml"), yml.replaceAll("__REPO__", repoPath));
  if (opts?.guidance) writeFileSync(join(repoDir, "guidelines-prompt.md"), opts.guidance);
  writeFileSync(join(base, "cfg", "env"), "JIRA_BASE_URL=https://x.atlassian.net/\nJIRA_EMAIL=me@x.com\nJIRA_API_TOKEN=tok\n");
  process.env.HERDR_CATS_CONFIG_DIR = join(base, "cfg");
  process.env.HERDR_CATS_STATE_ROOT = join(base, "state");
  return { repoPath };
}

describe("loadConfig", () => {
  it("maps yaml + applies defaults + strips trailing slash on base url", () => {
    const { repoPath } = setup(
      `repo:
  path: __REPO__
  base_ref: origin/master
jira:
  project: RWR
  board: 254
  status:
    todo: To Do
    in_development: In development
    review: Ready for Code Review
worker:
  bootstrap_cmd: mise run setup
`,
      { guidance: "- use the X skill" },
    );
    const { config, secrets } = loadConfig("demo");
    expect(config.repo.path).toBe(repoPath);
    expect(config.repo.baseRef).toBe("origin/master");
    expect(config.jira.project).toBe("RWR");
    expect(config.jira.board).toBe("254"); // coerced number → string
    expect(config.jira.label).toBe("agent"); // default
    expect(config.jira.statusInDev).toBe("In development");
    expect(config.worker.bootstrapCmd).toBe("mise run setup");
    expect(config.worker.deslopCmd).toBeUndefined();
    expect(config.layout.mainTab).toBe("main"); // default
    expect(config.limits.maxActive).toBe(3); // default
    expect(config.guidance).toContain("use the X skill");
    expect(secrets.jiraBaseUrl).toBe("https://x.atlassian.net");
    expect(config.paths.dbPath).toContain("herdr-cats.db");
  });

  it("rejects an invalid config (missing jira.project)", () => {
    setup(`repo:\n  path: __REPO__\njira:\n  board: 1\n`);
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a missing repo config", () => {
    setup(`repo:\n  path: __REPO__\njira:\n  project: P\n  board: 1\n`);
    expect(() => loadConfig("nope")).toThrow(/no config for repo/);
  });
});

describe("assertMainCheckout", () => {
  it("accepts a .git directory, rejects a .git file (linked worktree)", () => {
    const base = mkdtempSync(join(tmpdir(), "cats-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const main = join(base, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    const linked = join(base, "linked");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), "gitdir: /elsewhere");
    expect(() => assertMainCheckout(main)).not.toThrow();
    expect(() => assertMainCheckout(linked)).toThrow(/linked worktree/);
  });
});
