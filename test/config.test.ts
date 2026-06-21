import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, assertMainCheckout, expandHome } from "../src/config.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_FACTORY_CONFIG_DIR;
  delete process.env.HERDR_FACTORY_STATE_ROOT;
});

// A standard jira work source (one list item under `work_sources`). prompt_type: replace so each
// agent's prompt is exactly its file contents.
const JIRA_SOURCE = `  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: RWR
      board: 254
    agents:
      fix:    { tab: fix,    pane: agent, prompt_type: replace, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }
`;

/** Assemble a full config.yml from a `work_sources` body (already list-item indented). */
function cfg(workSources: string, head = "repo:\n  path: __REPO__\n"): string {
  return `${head}work_sources:\n${workSources}`;
}

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
  // Auth (email + token) is the only global secret now; base_url is per-source config.
  writeFileSync(join(base, "cfg", "env"), "JIRA_EMAIL=me@x.com\nJIRA_API_TOKEN=tok\n");
  process.env.HERDR_FACTORY_CONFIG_DIR = join(base, "cfg");
  process.env.HERDR_FACTORY_STATE_ROOT = join(base, "state");
  return { repoPath };
}

describe("loadConfig — work sources", () => {
  it("maps a jira source + applies defaults + strips trailing slash on its base url", () => {
    const { repoPath } = setup(
      cfg(`  - type: jira
    jira:
      base_url: https://x.atlassian.net/
      project: RWR
      board: 254
      status:
        todo: To Do
        in_development: In development
        review: Ready for Code Review
    agents:
      fix:    { tab: fix,    pane: agent, prompt_type: replace, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
      { guidance: "- use the X skill" },
    );
    const { config, secrets } = loadConfig("demo");
    expect(config.repo.path).toBe(repoPath);
    expect(config.sources.length).toBe(1);
    const s = config.sources[0]!;
    expect(s.name).toBe("jira"); // default name = type
    expect(s.type).toBe("jira");
    expect(s.priority).toBe(100); // default
    expect(s.jira!.baseUrl).toBe("https://x.atlassian.net"); // trailing slash stripped
    expect(s.jira!.project).toBe("RWR");
    expect(s.jira!.board).toBe("254"); // coerced number → string
    expect(s.jira!.label).toBe("agent"); // default
    expect(s.jira!.statusInDev).toBe("In development");
    expect(config.limits.stallSeconds).toBe(2700); // default
    expect(config.limits.maxActive).toBe(3); // default
    expect(config.guidance).toContain("use the X skill");
    expect(secrets.jiraEmail).toBe("me@x.com"); // auth still global
    expect(config.paths.dbPath).toContain("herdr-factory.db");
  });

  it("maps the three agent blocks per source + reads each prompt_file's contents", () => {
    setup(cfg(JIRA_SOURCE), {
      prompts: { "fix.md": "do the fix\n", "review.md": "review it\n", "pr.md": "open the PR\n" },
    });
    const a = loadConfig("demo").config.sources[0]!.agents;
    expect(a.fix.tab).toBe("fix");
    expect(a.fix.pane).toBe("agent");
    expect(a.fix.promptType).toBe("replace");
    expect(a.fix.promptFile).toMatch(/fix\.md$/);
    expect(a.fix.prompt).toBe("do the fix\n"); // replace → verbatim file contents
    expect(a.review.prompt).toBe("review it\n");
    expect(a.pr.prompt).toBe("open the PR\n");
  });

  it("augment mode: engine default prompt + the prompt_file as additions", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { tab: fix,    pane: agent, prompt_type: augment, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr,     pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
      { prompts: { "fix.md": "EXTRA: run the linter\n", "review.md": "r\n", "pr.md": "p\n" } },
    );
    const fix = loadConfig("demo").config.sources[0]!.agents.fix;
    expect(fix.promptType).toBe("augment");
    expect(fix.prompt).toContain("Fix agent"); // engine default heading (prompts/fix.md)
    expect(fix.prompt).toContain("Additional repo-specific instructions");
    expect(fix.prompt).toContain("EXTRA: run the linter");
  });

  it("local_markdown augment fix uses the per-type built-in prompt (prompts/local_markdown/fix.md)", () => {
    setup(
      cfg(`  - type: local_markdown
    local_markdown: { folder: ~/work }
    agents:
      fix:    { prompt_type: augment }
      review: { prompt_type: augment }
      pr:     { prompt_type: augment }
`),
      { prompts: {} },
    );
    const s = loadConfig("demo").config.sources[0]!;
    expect(s.type).toBe("local_markdown");
    expect(s.localMarkdown!.folder).toBe(join(homedir(), "work"));
    // the local_markdown fix prompt references the markdown task doc, not Jira
    expect(s.agents.fix.prompt).toContain("@@WORK_DOC@@");
    expect(s.agents.fix.prompt).not.toContain("Jira");
    // review/pr have no per-type override → fall back to the shared engine prompt
    expect(s.agents.review.prompt).toContain("fresh-eyes");
  });

  it("supports multiple sources, sorted by priority (ties keep config order)", () => {
    setup(
      cfg(`  - type: local_markdown
    name: docs
    priority: 5
    local_markdown: { folder: ~/work }
    agents:
      fix:    { prompt_type: augment }
      review: { prompt_type: augment }
      pr:     { prompt_type: augment }
  - type: jira
    priority: 1
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { prompt_type: augment }
      review: { prompt_type: augment }
      pr:     { prompt_type: augment }
`),
      { prompts: {} },
    );
    const sources = loadConfig("demo").config.sources;
    expect(sources.map((s) => s.name)).toEqual(["jira", "docs"]); // priority 1 before 5
    expect(sources[0]!.priority).toBe(1);
  });

  it("rejects duplicate (resolved) source names — two unnamed jira sources collide on 'jira'", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: A, board: 1 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
  - type: jira
    jira: { base_url: https://y.atlassian.net, project: B, board: 2 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate work source name/);
  });

  it("allows two jira sources with explicit unique names", () => {
    setup(
      cfg(`  - type: jira
    name: alpha
    jira: { base_url: https://x.atlassian.net, project: A, board: 1 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
  - type: jira
    name: beta
    jira: { base_url: https://y.atlassian.net, project: B, board: 2 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.sources.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("rejects a blank source name (can't bypass the type-default / uniqueness)", () => {
    setup(
      cfg(`  - type: jira
    name: ""
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects an agent missing prompt_type (no silent default)", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { tab: fix, pane: agent, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr, pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects replace mode without a prompt_file", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { tab: fix, pane: agent, prompt_type: replace }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr, pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
    );
    expect(() => loadConfig("demo")).toThrow(/prompt_file is required/);
  });

  it("allows an agent with no tab/pane (spawns its own pane)", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { prompt_type: augment }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr, pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
      { prompts: { "review.md": "r\n", "pr.md": "p\n" } },
    );
    const a = loadConfig("demo").config.sources[0]!.agents;
    expect(a.fix.tab).toBeUndefined();
    expect(a.fix.pane).toBeUndefined();
    expect(a.review.tab).toBe("review");
  });

  it("rejects an agent with tab but no pane (must be set together)", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { tab: fix, prompt_type: replace, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr, pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a source missing its agents block", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects an empty work_sources list", () => {
    setup("repo:\n  path: __REPO__\nwork_sources: []\n", { prompts: {} });
    expect(() => loadConfig("demo")).toThrow();
  });

  it("throws when an agent prompt_file is missing on disk", () => {
    setup(cfg(JIRA_SOURCE), { prompts: {} });
    expect(() => loadConfig("demo")).toThrow(/prompt_file not found/);
  });

  it("rejects a jira source missing project", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, board: 1 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a jira source missing base_url", () => {
    setup(
      cfg(`  - type: jira
    jira: { project: RWR, board: 254 }
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a local_markdown source missing its folder", () => {
    setup(
      cfg(`  - type: local_markdown
    local_markdown: {}
    agents: { fix: { prompt_type: augment }, review: { prompt_type: augment }, pr: { prompt_type: augment } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a missing repo config", () => {
    setup(cfg(JIRA_SOURCE));
    expect(() => loadConfig("nope")).toThrow(/no config for repo/);
  });

  it("maps a per-source workspace_name through", () => {
    setup(
      cfg(`  - type: jira
    workspace_name: "fix/{{ticket_id}}-{{ticket_short_slug}}"
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { tab: fix, pane: agent, prompt_type: replace, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr, pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
    );
    expect(loadConfig("demo").config.sources[0]!.workspaceName).toBe("fix/{{ticket_id}}-{{ticket_short_slug}}");
  });

  it("rejects a workspace_name template missing {{ticket_id}}", () => {
    setup(
      cfg(`  - type: jira
    workspace_name: "fix/{{ticket_short_slug}}"
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
    agents:
      fix:    { tab: fix, pane: agent, prompt_type: replace, prompt_file: fix.md }
      review: { tab: review, pane: agent, prompt_type: replace, prompt_file: review.md }
      pr:     { tab: pr, pane: agent, prompt_type: replace, prompt_file: pr.md }
`),
    );
    expect(() => loadConfig("demo")).toThrow(/ticket_id/);
  });
});

describe("expandHome", () => {
  it("expands leading ~ and $HOME, leaves absolute paths untouched", () => {
    const home = homedir();
    expect(expandHome("~/dev/x")).toBe(join(home, "dev/x"));
    expect(expandHome("~")).toBe(home);
    expect(expandHome("$HOME/dev/x")).toBe(`${home}/dev/x`);
    expect(expandHome("${HOME}/dev/x")).toBe(`${home}/dev/x`);
    expect(expandHome("/already/absolute")).toBe("/already/absolute");
    expect(expandHome("$HOMEWORK/x")).toBe("$HOMEWORK/x"); // not a HOME match
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
