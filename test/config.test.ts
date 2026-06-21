import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, assertMainCheckout } from "../src/config.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_FACTORY_CONFIG_DIR;
  delete process.env.HERDR_FACTORY_STATE_ROOT;
});

// A valid `agents` block (all three required) for configs that don't test agents themselves.
// Uses prompt_type: replace so each agent's prompt is exactly its file contents.
const AGENTS = `agents:
  fix:    { tab: fix,    pane: agent, prompt_type: replace, prompt_file: fix.md }
  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }
`;

// A valid `jira` block (base_url is per-repo + required) for configs that don't test jira.
const JIRA = `jira:
  base_url: https://x.atlassian.net
  project: RWR
  board: 254
`;

function setup(yml: string, opts?: { guidance?: string; prompts?: Record<string, string> }) {
  const base = mkdtempSync(join(tmpdir(), "cats-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const repoPath = join(base, "repo");
  mkdirSync(join(repoPath, ".git"), { recursive: true }); // main checkout: .git is a dir
  const repoDir = join(base, "cfg", "repos", "demo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "config.yml"), yml.replaceAll("__REPO__", repoPath));
  if (opts?.guidance) writeFileSync(join(repoDir, "guidelines-prompt.md"), opts.guidance);
  const prompts = opts?.prompts ?? { "fix.md": "FIX prompt\n", "review.md": "REVIEW prompt\n", "pr.md": "PR prompt\n" };
  for (const [name, body] of Object.entries(prompts)) writeFileSync(join(repoDir, name), body);
  // Auth (email + token) is the only global Jira secret now; base_url is per-repo config.
  writeFileSync(join(base, "cfg", "env"), "JIRA_EMAIL=me@x.com\nJIRA_API_TOKEN=tok\n");
  process.env.HERDR_FACTORY_CONFIG_DIR = join(base, "cfg");
  process.env.HERDR_FACTORY_STATE_ROOT = join(base, "state");
  return { repoPath };
}

describe("loadConfig", () => {
  it("maps yaml + applies defaults + strips trailing slash on the per-repo jira base url", () => {
    const { repoPath } = setup(
      `repo:
  path: __REPO__
  base_ref: origin/master
jira:
  base_url: https://x.atlassian.net/
  project: RWR
  board: 254
  status:
    todo: To Do
    in_development: In development
    review: Ready for Code Review
${AGENTS}`,
      { guidance: "- use the X skill" },
    );
    const { config, secrets } = loadConfig("demo");
    expect(config.repo.path).toBe(repoPath);
    expect(config.repo.baseRef).toBe("origin/master");
    expect(config.jira.baseUrl).toBe("https://x.atlassian.net"); // per-repo, trailing slash stripped
    expect(config.jira.project).toBe("RWR");
    expect(config.jira.board).toBe("254"); // coerced number → string
    expect(config.jira.label).toBe("agent"); // default
    expect(config.jira.statusInDev).toBe("In development");
    expect(config.limits.stallSeconds).toBe(2700); // default
    expect(config.limits.reviewBudgetSeconds).toBe(1800); // default
    expect(config.limits.prBudgetSeconds).toBe(3600); // default
    expect(config.limits.tickIntervalSeconds).toBe(60); // default
    expect(config.limits.maxActive).toBe(3); // default
    expect(config.guidance).toContain("use the X skill");
    expect(secrets.jiraEmail).toBe("me@x.com"); // auth still global
    expect(secrets.jiraApiToken).toBe("tok");
    expect(config.paths.dbPath).toContain("herdr-factory.db");
  });

  it("maps the three agent blocks + reads each prompt_file's contents", () => {
    setup(
      `repo:
  path: __REPO__
${JIRA}${AGENTS}`,
      { prompts: { "fix.md": "do the fix\n", "review.md": "review it\n", "pr.md": "open the PR\n" } },
    );
    const { config } = loadConfig("demo");
    expect(config.agents.fix.tab).toBe("fix");
    expect(config.agents.fix.pane).toBe("agent");
    expect(config.agents.fix.promptType).toBe("replace");
    expect(config.agents.fix.promptFile).toMatch(/fix\.md$/);
    expect(config.agents.fix.prompt).toBe("do the fix\n"); // replace → verbatim file contents
    expect(config.agents.review.tab).toBe("review");
    expect(config.agents.review.prompt).toBe("review it\n");
    expect(config.agents.pr.tab).toBe("pr");
    expect(config.agents.pr.prompt).toBe("open the PR\n");
  });

  it("augment mode: engine default prompt + the prompt_file as additions", () => {
    setup(
      `repo:\n  path: __REPO__\n${JIRA}agents:\n  fix:    { tab: fix,    pane: agent, prompt_type: augment, prompt_file: fix.md }\n  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }\n  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }\n`,
      { prompts: { "fix.md": "EXTRA: run the linter\n", "review.md": "r\n", "pr.md": "p\n" } },
    );
    const { config } = loadConfig("demo");
    expect(config.agents.fix.promptType).toBe("augment");
    expect(config.agents.fix.prompt).toContain("Fix agent"); // engine default heading
    expect(config.agents.fix.prompt).toContain("Additional repo-specific instructions");
    expect(config.agents.fix.prompt).toContain("EXTRA: run the linter"); // the addition
  });

  it("augment mode with no prompt_file: engine default only", () => {
    setup(
      `repo:\n  path: __REPO__\n${JIRA}agents:\n  fix:    { tab: fix,    pane: agent, prompt_type: augment }\n  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }\n  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }\n`,
      { prompts: { "review.md": "r\n", "pr.md": "p\n" } },
    );
    const { config } = loadConfig("demo");
    expect(config.agents.fix.promptFile).toBe("");
    expect(config.agents.fix.prompt).toContain("Fix agent");
    expect(config.agents.fix.prompt).not.toContain("Additional repo-specific instructions");
  });

  it("rejects an agent missing prompt_type (no silent default)", () => {
    setup(
      `repo:\n  path: __REPO__\n${JIRA}agents:\n  fix:    { tab: fix,    pane: agent, prompt_file: fix.md }\n  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }\n  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }\n`,
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects replace mode without a prompt_file", () => {
    setup(
      `repo:\n  path: __REPO__\n${JIRA}agents:\n  fix:    { tab: fix,    pane: agent, prompt_type: replace }\n  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }\n  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }\n`,
    );
    expect(() => loadConfig("demo")).toThrow(/prompt_file is required/);
  });

  it("allows an agent with no tab/pane (it will spawn its own pane)", () => {
    setup(
      `repo:\n  path: __REPO__\n${JIRA}agents:\n  fix:    { prompt_type: augment }\n  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }\n  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }\n`,
      { prompts: { "review.md": "r\n", "pr.md": "p\n" } },
    );
    const { config } = loadConfig("demo");
    expect(config.agents.fix.tab).toBeUndefined();
    expect(config.agents.fix.pane).toBeUndefined();
    expect(config.agents.review.tab).toBe("review");
  });

  it("rejects an agent with tab but no pane (must be set together)", () => {
    setup(
      `repo:\n  path: __REPO__\n${JIRA}agents:\n  fix:    { tab: fix, prompt_type: replace, prompt_file: fix.md }\n  review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }\n  pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }\n`,
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a config missing the agents block", () => {
    setup(`repo:\n  path: __REPO__\n${JIRA}`, { prompts: {} });
    expect(() => loadConfig("demo")).toThrow();
  });

  it("throws when an agent prompt_file is missing", () => {
    setup(`repo:\n  path: __REPO__\n${JIRA}${AGENTS}`, { prompts: {} });
    expect(() => loadConfig("demo")).toThrow(/prompt_file not found/);
  });

  it("rejects an invalid config (missing jira.project)", () => {
    setup(`repo:\n  path: __REPO__\njira:\n  base_url: https://x.atlassian.net\n  board: 1\n${AGENTS}`);
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a jira block missing base_url", () => {
    setup(`repo:\n  path: __REPO__\njira:\n  project: RWR\n  board: 254\n${AGENTS}`);
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a missing repo config", () => {
    setup(`repo:\n  path: __REPO__\n${JIRA}${AGENTS}`);
    expect(() => loadConfig("nope")).toThrow(/no config for repo/);
  });

  it("maps workspace_name through", () => {
    setup(`repo:\n  path: __REPO__\n${JIRA}workspace_name: "fix/{{ticket_id}}-{{ticket_short_slug}}"\n${AGENTS}`);
    expect(loadConfig("demo").config.workspaceName).toBe("fix/{{ticket_id}}-{{ticket_short_slug}}");
  });

  it("rejects a workspace_name template missing {{ticket_id}}", () => {
    setup(`repo:\n  path: __REPO__\n${JIRA}workspace_name: "fix/{{ticket_short_slug}}"\n${AGENTS}`);
    expect(() => loadConfig("demo")).toThrow(/ticket_id/);
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
