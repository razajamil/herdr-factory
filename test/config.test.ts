import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, assertMainCheckout, expandHome, configJsonSchema, evidenceKeyPrefix } from "../src/config.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_FACTORY_CONFIG_DIR;
  delete process.env.HERDR_FACTORY_STATE_ROOT;
});

// Reusable config fragments (already list-item indented).
const JIRA_SRC = `  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
const LM_SRC = `  - type: local_markdown
    name: ideas
    local_markdown: { folder: ~/work }
`;
// A work_to_pull_request belt: layout-only agents (the engine ships the prompts).
const SHIP_BELT = `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    agents:
      fix:    { tab: fix,    pane: agent }
      review: { tab: review, pane: agent }
      pr:     { tab: pr,     pane: agent }
`;

/** Assemble a full config.yml from a `work_sources` body + a `belt` body (both list-item indented). */
function cfg(workSources: string, belts: string, head = "repo:\n  path: __REPO__\n"): string {
  return `${head}work_sources:\n${workSources}belt:\n${belts}`;
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
  for (const [name, body] of Object.entries(opts?.prompts ?? {})) writeFileSync(join(repoDir, name), body);
  // Jira auth (email + token) is strictly per-repo, in repos/<name>/env.
  writeFileSync(join(repoDir, "env"), "JIRA_EMAIL=me@x.com\nJIRA_API_TOKEN=tok\n");
  process.env.HERDR_FACTORY_CONFIG_DIR = join(base, "cfg");
  process.env.HERDR_FACTORY_STATE_ROOT = join(base, "state");
  return { repoPath, repoDir };
}

describe("loadConfig — work sources + belts", () => {
  it("maps a jira source + a work_to_pull_request belt + applies defaults + strips trailing slash", () => {
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
`, SHIP_BELT),
      { guidance: "- use the X skill" },
    );
    const { config, secrets } = loadConfig("demo");
    expect(config.repo.path).toBe(repoPath);
    expect(config.sources.length).toBe(1);
    const s = config.sources[0]!;
    expect(s.name).toBe("jira"); // default name = type
    expect(s.type).toBe("jira");
    expect(s.jira!.baseUrl).toBe("https://x.atlassian.net"); // trailing slash stripped
    expect(s.jira!.project).toBe("RWR");
    expect(s.jira!.board).toBe("254"); // coerced number → string
    expect(s.jira!.label).toBe("agent"); // default
    expect(s.jira!.statusInDev).toBe("In development");
    expect(config.limits.stallSeconds).toBe(2700); // default
    expect(config.limits.maxActive).toBe(3); // default
    expect(config.limits.stepBudgetSeconds).toBe(3600); // default
    expect(config.guidance).toContain("use the X skill");
    expect(secrets.jiraEmail).toBe("me@x.com"); // auth still global
    expect(config.paths.dbPath).toContain("herdr-factory.db");

    const belt = config.belts[0]!;
    expect(belt.name).toBe("ship");
    expect(belt.beltType).toBe("work_to_pull_request");
    expect(belt.source).toBe("jira");
    expect(belt.priority).toBe(100); // default
    expect(belt.watchPr).toBe(true);
  });

  it("loads Jira secrets strictly from the per-repo env (a shared global env is ignored)", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} }); // setup writes repos/demo/env: me@x.com / tok
    // A global <configDir>/env must NOT be consulted — secrets are per-repo only.
    writeFileSync(join(process.env.HERDR_FACTORY_CONFIG_DIR!, "env"), "JIRA_EMAIL=global@x.com\nJIRA_API_TOKEN=global-tok\n");
    const { secrets } = loadConfig("demo");
    expect(secrets.jiraEmail).toBe("me@x.com"); // per-repo, not the global
    expect(secrets.jiraApiToken).toBe("tok");
  });

  it("SKIPS the evidence step when it has no tab/pane (fix → review → pr) — evidence never self-spawns", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} }); // SHIP_BELT configures no evidence tab/pane
    const belt = loadConfig("demo").config.belts[0]!;
    const steps = belt.steps;
    expect(steps.map((s) => s.name)).toEqual(["fix", "review", "pr"]); // evidence dropped entirely
    const [fix, review, pr] = steps;
    expect(fix!.tab).toBe("fix");
    expect(fix!.pane).toBe("agent");
    expect(fix!.enginePrompt).toContain("Fix agent"); // shipped engine prompt (src/prompts/fix.md)
    expect(fix!.heartbeat).toBe(true);
    expect(fix!.opensPr).toBe(false);
    expect(fix!.budgetSeconds).toBe(5400); // develop_budget_seconds
    expect(fix!.canBounceTo).toEqual([]);
    expect(review!.enginePrompt).toContain("fresh-eyes");
    expect(review!.heartbeat).toBe(false);
    expect(review!.budgetSeconds).toBe(1800);
    expect(review!.canBounceTo).toEqual(["fix"]); // review still bounces back to fix
    expect(pr!.enginePrompt).toContain("PR agent");
    expect(pr!.opensPr).toBe(true); // only the pr step watches GitHub
    expect(pr!.budgetSeconds).toBe(3600);
    expect(belt.maxBounces).toBeUndefined(); // no per-belt override → falls back to limits.maxBounces
  });

  it("INCLUDES the evidence step only when its tab/pane are set (fix → evidence → review → pr)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    agents:
      fix:      { tab: fix,      pane: agent }
      evidence: { tab: evidence, pane: agent }
      review:   { tab: review,   pane: agent }
      pr:       { tab: pr,       pane: agent }
`),
      { prompts: {} },
    );
    const steps = loadConfig("demo").config.belts[0]!.steps;
    expect(steps.map((s) => s.name)).toEqual(["fix", "evidence", "review", "pr"]);
    const evidence = steps.find((s) => s.name === "evidence")!;
    expect(evidence.tab).toBe("evidence"); // delivers to that pane's existing agent (no self-spawn)
    expect(evidence.pane).toBe("agent");
    expect(evidence.enginePrompt).toContain("Evidence agent"); // src/prompts/evidence.md
    expect(evidence.heartbeat).toBe(false);
    expect(evidence.opensPr).toBe(false);
    expect(evidence.budgetSeconds).toBe(2400); // evidence_budget_seconds
    expect(evidence.gathersEvidence).toBe(true);
    expect(evidence.canBounceTo).toEqual(["fix"]);
  });

  it("max_bounces defaults to 6 and a per-belt max_bounces overrides the repo limit", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    max_bounces: 2
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect(config.limits.maxBounces).toBe(6); // raised safety-backstop default
    expect(config.belts[0]!.maxBounces).toBe(2); // per-belt override
  });

  it("a work_to_pull_request belt on a local_markdown source uses the per-type built-in fix prompt", () => {
    setup(
      cfg(LM_SRC, `  - name: lm-ship
    belt_type: work_to_pull_request
    source: ideas
    agents:
      fix:    { tab: fix,    pane: agent }
      review: { tab: review, pane: agent }
      pr:     { tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect(config.sources[0]!.type).toBe("local_markdown");
    expect(config.sources[0]!.localMarkdown!.folder).toBe(join(homedir(), "work"));
    const fix = config.belts[0]!.steps.find((s) => s.name === "fix")!;
    // the local_markdown fix prompt references the markdown task doc, not Jira
    expect(fix.enginePrompt).toContain("@@WORK_DOC@@");
    expect(fix.enginePrompt).not.toContain("Jira");
    // review/pr have no per-type override → shared engine prompt
    expect(config.belts[0]!.steps.find((s) => s.name === "review")!.enginePrompt).toContain("fresh-eyes");
  });

  it("resolves a custom belt's user-defined steps (prompt_file body, budget, heartbeat, no PR)", () => {
    setup(
      cfg(LM_SRC, `  - name: work_generation
    belt_type: custom
    source: ideas
    workspace_name: "research/{{work_id}}-{{work_slug}}"
    steps:
      - { name: research, tab: research, pane: agent, prompt_file: research.md, prompt_file_source: config }
      - { name: create_jira_ticket, prompt_file: create.md, prompt_file_source: repo, budget_seconds: 1200, heartbeat: true }
`),
      { prompts: { "research.md": "Do the research\n" } },
    );
    const belt = loadConfig("demo").config.belts[0]!;
    expect(belt.beltType).toBe("custom");
    expect(belt.watchPr).toBe(false);
    expect(belt.workspaceName).toBe("research/{{work_id}}-{{work_slug}}");
    expect(belt.steps.map((s) => s.name)).toEqual(["research", "create_jira_ticket"]);
    const [research, create] = belt.steps;
    // The body is read at RENDER time now — config carries the file reference + source, not the text.
    expect(research!.promptFile).toBe("research.md");
    expect(research!.promptFileSource).toBe("config");
    expect(research!.enginePrompt).toBeUndefined(); // custom belts have no engine base
    expect(research!.tab).toBe("research");
    expect(research!.budgetSeconds).toBe(3600); // default step_budget_seconds
    expect(research!.heartbeat).toBe(false); // default off for custom
    expect(research!.opensPr).toBe(false);
    expect(create!.promptFile).toBe("create.md");
    expect(create!.promptFileSource).toBe("repo"); // repo-sourced: not existence-checked at load
    expect(create!.budgetSeconds).toBe(1200); // per-step override
    expect(create!.heartbeat).toBe(true);
    expect(create!.tab).toBeUndefined(); // no layout → spawns its own pane
  });

  it("loads a belt's match file path (existence verified, fn loaded later in buildDeps)", () => {
    const { repoDir } = setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    match: match.ts
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: { "match.ts": "export default () => true;\n" } },
    );
    expect(loadConfig("demo").config.belts[0]!.matchFile).toBe(join(repoDir, "match.ts"));
  });

  it("throws when a belt's match file is missing on disk", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    match: nope.ts
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/match not found/);
  });

  it("sorts belts by priority (ties keep config order)", () => {
    setup(
      cfg(`${JIRA_SRC}${LM_SRC}`, `  - name: low
    belt_type: work_to_pull_request
    source: ideas
    priority: 5
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
  - name: high
    belt_type: work_to_pull_request
    source: jira
    priority: 1
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    const belts = loadConfig("demo").config.belts;
    expect(belts.map((b) => b.name)).toEqual(["high", "low"]); // priority 1 before 5
    expect(belts[0]!.priority).toBe(1);
  });

  it("rejects duplicate (resolved) source names — two unnamed jira sources collide on 'jira'", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: A, board: 1 }
  - type: jira
    jira: { base_url: https://y.atlassian.net, project: B, board: 2 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate work source name/);
  });

  it("rejects a blank source name", () => {
    setup(
      cfg(`  - type: jira
    name: ""
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a belt referencing an unknown work source", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: nonexistent
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/unknown work source/);
  });

  it("rejects duplicate belt names", () => {
    setup(
      cfg(JIRA_SRC, `  - name: dup
    belt_type: work_to_pull_request
    source: jira
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
  - name: dup
    belt_type: work_to_pull_request
    source: jira
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate belt name/);
  });

  it("rejects a custom belt with duplicate step names", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    belt_type: custom
    source: ideas
    steps:
      - { name: research, prompt_file: a.md, prompt_file_source: config }
      - { name: research, prompt_file: b.md, prompt_file_source: config }
`),
      { prompts: { "a.md": "a\n", "b.md": "b\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate step name/);
  });

  it("rejects a custom belt step with an invalid (non-slug) name", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    belt_type: custom
    source: ideas
    steps:
      - { name: "Bad Name", prompt_file: a.md, prompt_file_source: config }
`),
      { prompts: { "a.md": "a\n" } },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("throws when a custom belt step's prompt_file is missing on disk", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    belt_type: custom
    source: ideas
    steps:
      - { name: research, prompt_file: missing.md, prompt_file_source: config }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/prompt_file.*not found/);
  });

  it("rejects a custom belt with no steps", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    belt_type: custom
    source: ideas
    steps: []
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a custom belt that carries an agents block (strict — the w2pr/custom mixup)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    belt_type: custom
    source: ideas
    steps:
      - { name: research, prompt_file: r.md, prompt_file_source: config }
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: { "r.md": "r\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/Unrecognized key|agents/i);
  });

  it("rejects a work_to_pull_request belt that carries a steps array (strict)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
    steps: []
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/Unrecognized key|steps/i);
  });

  it("rejects a work_to_pull_request agent with tab but no pane (must be set together)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    agents:
      fix:    { tab: fix }
      review: { tab: review, pane: agent }
      pr:     { tab: pr, pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a work_to_pull_request belt missing its agents block", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects an empty work_sources list", () => {
    setup("repo:\n  path: __REPO__\nwork_sources: []\nbelt: []\n", { prompts: {} });
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects an empty belt list", () => {
    setup(`repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt: []\n`, { prompts: {} });
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a jira source missing project", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, board: 1 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a jira source missing base_url", () => {
    setup(
      cfg(`  - type: jira
    jira: { project: RWR, board: 254 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a local_markdown source missing its folder", () => {
    setup(
      cfg(`  - type: local_markdown
    name: ideas
    local_markdown: {}
`, `  - name: ship
    belt_type: work_to_pull_request
    source: ideas
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a missing repo config", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    expect(() => loadConfig("nope")).toThrow(/no config for repo/);
  });

  it("resolves the evidence block incl. the optional github_username override (+ trims key_prefix, normalizes cloudfront)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  bucket: my-bucket
  region: us-east-1
  cloudfront_domain: https://d1.cloudfront.net/
  key_prefix: /sub/
  github_username: alice
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    expect(ev.bucket).toBe("my-bucket");
    expect(ev.cloudfrontDomain).toBe("d1.cloudfront.net"); // scheme + trailing slash stripped
    expect(ev.keyPrefix).toBe("sub"); // leading/trailing slashes trimmed
    expect(ev.githubUsername).toBe("alice");
  });

  it("leaves githubUsername undefined when the evidence block omits it (derived from gh at upload time)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  bucket: my-bucket
  region: us-east-1
  cloudfront_domain: d1.cloudfront.net
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    expect(ev.githubUsername).toBeUndefined();
    expect(ev.keyPrefix).toBe(""); // default
  });

  it("maps a per-belt workspace_name through", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    workspace_name: "fix/{{work_id}}-{{work_slug}}"
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts[0]!.workspaceName).toBe("fix/{{work_id}}-{{work_slug}}");
  });

  it("rejects a workspace_name template missing {{work_id}}", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    workspace_name: "fix/{{work_slug}}"
    agents: { fix: { tab: fix, pane: agent }, review: { tab: review, pane: agent }, pr: { tab: pr, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/work_id/);
  });
});

describe("configJsonSchema", () => {
  it("generates a JSON Schema for config.yml editor validation, derived from the zod schema", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const js = configJsonSchema() as any;
    expect(String(js.$schema)).toContain("json-schema.org");
    expect(js.required).toEqual(expect.arrayContaining(["repo", "work_sources", "belt"]));
    const beltVariants = js.properties.belt.items.oneOf ?? js.properties.belt.items.anyOf;
    expect(beltVariants.map((v: { properties: { belt_type: { const: string } } }) => v.properties.belt_type.const).sort()).toEqual([
      "custom",
      "work_to_pull_request",
    ]);
    // .strict() → additionalProperties:false, so editors flag unknown keys (the agents-on-custom mixup)
    expect(beltVariants.every((v: { additionalProperties: unknown }) => v.additionalProperties === false)).toBe(true);
    // the step-name slug regex survives into the schema
    const custom = beltVariants.find((v: { properties: { belt_type: { const: string } } }) => v.properties.belt_type.const === "custom");
    expect(custom.properties.steps.items.properties.name.pattern).toBeTruthy();
  });

  it("the committed repo-root config.schema.json is in sync (the example's modeline resolves to it)", () => {
    // examples/example-repo/config.yml's `# yaml-language-server: $schema=../../config.schema.json`
    // resolves to <repo>/config.schema.json when edited in-repo — so it must be committed + current.
    const repoRoot = fileURLToPath(new URL("../", import.meta.url)); // test/ → repo root
    const committed = JSON.parse(readFileSync(join(repoRoot, "config.schema.json"), "utf8"));
    expect(committed, "config.schema.json is stale — regenerate with `npm run schema`").toEqual(configJsonSchema());
  });
});

describe("evidenceKeyPrefix", () => {
  it("builds herdr-factory / user / key_prefix / ticket / run-stamp, dropping empty segments", () => {
    expect(evidenceKeyPrefix({ githubUsername: "alice", keyPrefix: "proj", ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/alice/proj/RWR-1/5-T");
    expect(evidenceKeyPrefix({ keyPrefix: "proj", ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/proj/RWR-1/5-T"); // no username
    expect(evidenceKeyPrefix({ githubUsername: "alice", ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/alice/RWR-1/5-T"); // no key_prefix
    expect(evidenceKeyPrefix({ ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/RWR-1/5-T"); // neither → base only
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
