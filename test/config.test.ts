import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig, assertMainCheckout, expandHome, configJsonSchema, evidenceKeyPrefix, RepoConfigSchema } from "../src/config.ts";
import type { JiraSourceCfg } from "../src/clients/jira-source.ts";
import type { SentrySourceCfg } from "../src/clients/sentry-source.ts";
import type { GithubIssuesSourceCfg } from "../src/clients/github-issues-source.ts";
import type { LocalMarkdownSourceCfg } from "../src/sources/local-markdown/descriptor.ts";

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
const SENTRY_SRC = `  - type: sentry
    sentry: { organization: acme, projects: [backend], environment: [production], query: "is:unresolved level:error" }
`;
// A belt is one ordered steps[] list referencing registered step primitives by `type` (the engine
// ships their prompts). `label` is the per-belt pickup label — REQUIRED for a belt on a label-driven
// source (jira here). No evidence step here ⇒ work → review → pr.
const SHIP_BELT = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
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
  it("maps a jira source + a belt + applies defaults + strips trailing slash", () => {
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
    const { config, env } = loadConfig("demo");
    expect(config.repo.path).toBe(repoPath);
    expect(config.sources.length).toBe(1);
    const s = config.sources[0]!;
    expect(s.name).toBe("jira"); // default name = type
    expect(s.type).toBe("jira");
    const jira = s.cfg as JiraSourceCfg; // resolved by the jira descriptor
    expect(jira.baseUrl).toBe("https://x.atlassian.net"); // trailing slash stripped
    expect(jira.project).toBe("RWR");
    expect(jira.board).toBe("254"); // the required Agile board id pickup pulls from (coerced to string)
    expect((jira as unknown as Record<string, unknown>).label).toBeUndefined(); // label is per-belt now, not on the source
    expect(jira.statusInDev).toBe("In development");
    expect(jira.statusDone).toBeUndefined(); // opt-in: no `status.done` ⇒ terminal stays unmapped
    expect(config.limits.stallSeconds).toBe(2700); // default
    expect(config.limits.maxActiveWorkspaces).toBe(3); // default
    expect(config.limits.stepBudgetSeconds).toBe(3600); // default
    expect(config.guidance).toContain("use the X skill");
    expect(env.JIRA_EMAIL).toBe("me@x.com"); // auth still per-repo env
    expect(config.paths.dbPath).toContain("herdr-factory.db");

    const belt = config.belts[0]!;
    expect(belt.name).toBe("ship");
    expect(belt.beltType).toBe("work_to_pull_request"); // DERIVED display label (a pr step ⇒ PR watch)
    expect(belt.source).toBe("jira");
    expect(belt.label).toBe("agent"); // per-belt pickup label (no default — set in SHIP_BELT)
    expect(belt.priority).toBe(100); // default
    expect(belt.watchPr).toBe(true); // derived: a step produces pull_request
  });

  it("resolves an opt-in status.done to statusDone (trimmed)", () => {
    setup(
      cfg(
        `  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: RWR
      board: 254
      status:
        done: "  Done  "
`,
        SHIP_BELT,
      ),
    );
    const jira = loadConfig("demo").config.sources[0]!.cfg as JiraSourceCfg;
    expect(jira.statusDone).toBe("Done"); // .trim().min(1)
  });

  it("requires the Agile board (no default) and coerces a numeric id to a string", () => {
    setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR }\n`, SHIP_BELT));
    expect(() => loadConfig("demo")).toThrow(/board/); // required, no default

    setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }\n`, SHIP_BELT));
    expect((loadConfig("demo").config.sources[0]!.cfg as JiraSourceCfg).board).toBe("254");
  });

  it("rejects an unknown key in the jira block (the strict block — e.g. a stray `auth` or typo)", () => {
    setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254, auth: { method: oauth } }\n`, SHIP_BELT));
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized|auth/);
  });

  it("maps a github_issues source with defaults (labels, close_on, type map) and camelCase resolution", () => {
    setup(
      cfg(
        `  - type: github_issues
    name: gh
    github_issues: { repo: acme/tracker }
`,
        `  - name: ship
    source: gh
    label: factory
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`,
      ),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    const s = config.sources[0]!;
    expect(s.name).toBe("gh");
    expect(s.type).toBe("github_issues");
    const gh = s.cfg as GithubIssuesSourceCfg;
    expect(gh.repo).toBe("acme/tracker");
    expect((gh as unknown as Record<string, unknown>).triggerLabel).toBeUndefined(); // trigger label is per-belt now
    expect(gh.stateLabels).toEqual({ inDevelopment: "herdr:in-development", inReview: "herdr:in-review", aborted: "herdr:aborted" });
    expect(gh.closeOn).toEqual({ merged: true, done: true, aborted: false });
    expect(gh.typeLabels.bug).toBe("Bug");
    expect(gh.defaultType).toBe("Feature");
    expect(gh.maxPages).toBe(1);
    expect(config.belts[0]!.source).toBe("gh");
    expect(config.belts[0]!.label).toBe("factory"); // the belt's trigger/pickup label
  });

  describe("poll interval resolution", () => {
    it("defaults each source's poll interval to the tick interval (poll every tick)", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT));
      const { config } = loadConfig("demo");
      expect(config.limits.tickIntervalSeconds).toBe(60); // default
      expect(config.sources[0]!.pollIntervalSeconds).toBe(60); // == tick ⇒ unchanged behavior
    });

    it("follows a custom tick interval when neither poll field is set", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, "repo:\n  path: __REPO__\nlimits: { tick_interval_seconds: 30 }\n"));
      expect(loadConfig("demo").config.sources[0]!.pollIntervalSeconds).toBe(30);
    });

    it("limits.source_poll_interval_seconds is the repo-wide default for every source", () => {
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT, "repo:\n  path: __REPO__\nlimits: { source_poll_interval_seconds: 300 }\n"));
      const { config } = loadConfig("demo");
      expect(config.sources.map((s) => s.pollIntervalSeconds)).toEqual([300, 300]);
    });

    it("a per-source poll_interval_seconds overrides the repo default", () => {
      const jiraSlow = `  - type: jira
    poll_interval_seconds: 600
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(`${jiraSlow}${LM_SRC}`, SHIP_BELT, "repo:\n  path: __REPO__\nlimits: { source_poll_interval_seconds: 120 }\n"));
      const { config } = loadConfig("demo");
      // jira gets its own 600; the unqualified local_markdown falls back to the repo default 120.
      expect(config.sources.find((s) => s.type === "jira")!.pollIntervalSeconds).toBe(600);
      expect(config.sources.find((s) => s.type === "local_markdown")!.pollIntervalSeconds).toBe(120);
    });

    it("rejects a non-positive poll_interval_seconds", () => {
      const bad = `  - type: jira
    poll_interval_seconds: 0
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(bad, SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow();
    });
  });

  it("github_issues: repo may be omitted (defaults to the PR repo at build time); bad shapes rejected", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: {}
`,
        `  - name: ship
    source: github_issues
    label: herdr
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`,
      ),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect((config.sources[0]!.cfg as GithubIssuesSourceCfg).repo).toBeUndefined();

    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: not-a-repo }
`,
        SHIP_BELT.replace("source: jira", "source: github_issues"),
      ),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/owner\/name/);
  });

  it("github_issues: unknown keys in the block are rejected (strict)", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: acme/tracker, labels: nope }
`,
        SHIP_BELT.replace("source: jira", "source: github_issues"),
      ),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized/);
  });

  it("loads secrets strictly from the per-repo env (a shared global env is ignored)", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} }); // setup writes repos/demo/env: me@x.com / tok
    // A global <configDir>/env must NOT be consulted — secrets are per-repo only.
    writeFileSync(join(process.env.HERDR_FACTORY_CONFIG_DIR!, "env"), "JIRA_EMAIL=global@x.com\nJIRA_API_TOKEN=global-tok\n");
    const { env } = loadConfig("demo");
    expect(env.JIRA_EMAIL).toBe("me@x.com"); // per-repo, not the global
    expect(env.JIRA_API_TOKEN).toBe("tok");
  });

  it("recreates work_to_pull_request byte-identically from primitives (work/evidence/review/pr)", () => {
    // The anchor: the shipped primitives resolve to the historical PR_STEPS shape (fix→work rename).
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,     tab: work,     pane: agent }
      - { type: evidence, tab: evidence, pane: agent }
      - { type: review,   tab: review,   pane: agent }
      - { type: pr,       tab: pr,       pane: agent }
`),
      { prompts: {} },
    );
    const belt = loadConfig("demo").config.belts[0]!;
    expect(belt.watchPr).toBe(true);
    expect(belt.beltType).toBe("work_to_pull_request");
    expect(belt.steps.map((s) => s.name)).toEqual(["work", "evidence", "review", "pr"]);
    expect(belt.steps.map((s) => s.budgetSeconds)).toEqual([5400, 2400, 1800, 3600]);
    expect(belt.steps.map((s) => s.heartbeat)).toEqual([true, false, false, true]);
    expect(belt.steps.map((s) => s.opensPr)).toEqual([false, false, false, true]);
    expect(belt.steps.map((s) => s.gathersEvidence)).toEqual([false, true, false, false]);
    expect(belt.steps.map((s) => s.canBounceTo)).toEqual([[], ["work"], ["work"], []]);
  });

  it("SKIPS the evidence step when it has no tab/pane (work → review → pr) — evidence never self-spawns", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} }); // SHIP_BELT configures no evidence step
    const belt = loadConfig("demo").config.belts[0]!;
    const steps = belt.steps;
    expect(steps.map((s) => s.name)).toEqual(["work", "review", "pr"]); // no evidence step
    const [work, review, pr] = steps;
    expect(work!.tab).toBe("work");
    expect(work!.pane).toBe("agent");
    expect(work!.enginePrompt).toContain("ticket.json"); // shipped jira work prompt (src/prompts/jira/work.md)
    expect(work!.heartbeat).toBe(true);
    expect(work!.opensPr).toBe(false);
    expect(work!.budgetSeconds).toBe(5400); // work descriptor default
    expect(work!.canBounceTo).toEqual([]);
    expect(review!.enginePrompt).toContain("fresh-eyes");
    expect(review!.heartbeat).toBe(false);
    expect(review!.budgetSeconds).toBe(1800);
    expect(review!.canBounceTo).toEqual(["work"]); // review bounces back to work
    expect(pr!.enginePrompt).toContain("push"); // shipped pr prompt
    expect(pr!.opensPr).toBe(true); // only the pr step watches GitHub
    expect(pr!.budgetSeconds).toBe(3600);
    expect(belt.maxBounces).toBeUndefined(); // no per-belt override → falls back to limits.maxBounces
  });

  it("INCLUDES the evidence step only when its tab/pane are set (work → evidence → review → pr)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,     tab: work,     pane: agent }
      - { type: evidence, tab: evidence, pane: agent }
      - { type: review,   tab: review,   pane: agent }
      - { type: pr,       tab: pr,       pane: agent }
`),
      { prompts: {} },
    );
    const steps = loadConfig("demo").config.belts[0]!.steps;
    expect(steps.map((s) => s.name)).toEqual(["work", "evidence", "review", "pr"]);
    const evidence = steps.find((s) => s.name === "evidence")!;
    expect(evidence.tab).toBe("evidence"); // delivers to that pane's existing agent (no self-spawn)
    expect(evidence.pane).toBe("agent");
    expect(evidence.enginePrompt).toContain("Evidence agent"); // src/prompts/evidence.md
    expect(evidence.heartbeat).toBe(false);
    expect(evidence.opensPr).toBe(false);
    expect(evidence.budgetSeconds).toBe(2400); // evidence descriptor default
    expect(evidence.gathersEvidence).toBe(true);
    expect(evidence.readOnly).toBe(true);
    expect(evidence.canBounceTo).toEqual(["work"]);
  });

  it("max_bounces defaults to 6 and a per-belt max_bounces overrides the repo limit", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    max_bounces: 2
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect(config.limits.maxBounces).toBe(6); // raised safety-backstop default
    expect(config.belts[0]!.maxBounces).toBe(2); // per-belt override
  });

  it("a belt on a local_markdown source uses the neutral shared work prompt (no Jira wording)", () => {
    setup(
      cfg(LM_SRC, `  - name: lm-ship
    source: ideas
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect(config.sources[0]!.type).toBe("local_markdown");
    expect((config.sources[0]!.cfg as LocalMarkdownSourceCfg).folder).toBe(join(homedir(), "work"));
    const work = config.belts[0]!.steps.find((s) => s.name === "work")!;
    // local_markdown has no per-type work override — the neutral SHARED work prompt (WORK_DOC-based,
    // no Jira wording) covers it, and carries the rework/ask-human guidance.
    expect(work.enginePrompt).toContain("@@WORK_DOC@@");
    expect(work.enginePrompt).not.toContain("Jira");
    expect(work.enginePrompt).toContain("ask-human");
    // review has no per-type override → shared engine prompt
    expect(config.belts[0]!.steps.find((s) => s.name === "review")!.enginePrompt).toContain("fresh-eyes");
  });

  it("a belt on a github_issues source uses the per-type work + pr prompts", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: acme/tracker }
`,
        `  - name: gh-ship
    source: github_issues
    label: herdr
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`,
      ),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    const steps = config.belts[0]!.steps;
    const work = steps.find((s) => s.name === "work")!;
    expect(work.enginePrompt).toContain("GitHub issue");
    expect(work.enginePrompt).toContain("issue.json");
    const pr = steps.find((s) => s.name === "pr")!;
    expect(pr.enginePrompt).toContain("Closing reference"); // the auto-close linkage mandate
    // review has no per-type override → shared engine prompt
    expect(steps.find((s) => s.name === "review")!.enginePrompt).toContain("fresh-eyes");
  });

  it("a jira belt keeps the Jira-flavored work prompt (under prompts/jira/)", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    const work = loadConfig("demo").config.belts[0]!.steps.find((s) => s.name === "work")!;
    expect(work.enginePrompt).toContain("Jira ticket");
    expect(work.enginePrompt).toContain("ticket.json");
  });

  it("resolves a custom belt's user-defined steps (prompt_file body, budget, heartbeat, no PR)", () => {
    setup(
      cfg(LM_SRC, `  - name: work_generation
    source: ideas
    workspace_name: "research/{{work_id}}-{{work_slug}}"
    steps:
      - { type: custom, name: research, tab: research, pane: agent, prompt_file: research.md, prompt_file_source: config }
      - { type: custom, name: create_jira_ticket, prompt_file: create.md, prompt_file_source: repo, budget_seconds: 1200, heartbeat: true }
`),
      { prompts: { "research.md": "Do the research\n" } },
    );
    const belt = loadConfig("demo").config.belts[0]!;
    expect(belt.beltType).toBe("custom"); // no pr step ⇒ display label "custom"
    expect(belt.watchPr).toBe(false);
    expect(belt.workspaceName).toBe("research/{{work_id}}-{{work_slug}}");
    expect(belt.steps.map((s) => s.name)).toEqual(["research", "create_jira_ticket"]);
    const [research, create] = belt.steps;
    // The body is read at RENDER time now — config carries the file reference + source, not the text.
    expect(research!.promptFile).toBe("research.md");
    expect(research!.promptFileSource).toBe("config");
    expect(research!.enginePrompt).toBeUndefined(); // custom steps have no engine base
    expect(research!.tab).toBe("research");
    expect(research!.budgetSeconds).toBe(3600); // default step_budget_seconds (no descriptor default)
    expect(research!.heartbeat).toBe(false); // default off for custom
    expect(research!.opensPr).toBe(false);
    expect(create!.promptFile).toBe("create.md");
    expect(create!.promptFileSource).toBe("repo"); // repo-sourced: not existence-checked at load
    expect(create!.budgetSeconds).toBe(1200); // per-step override
    expect(create!.heartbeat).toBe(true); // opted in
    expect(create!.tab).toBeUndefined(); // no layout → spawns its own pane
  });

  it("defaults a step's name to its type when omitted", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    const names = loadConfig("demo").config.belts[0]!.steps.map((s) => s.name);
    expect(names).toEqual(["work", "review", "pr"]); // names default to the step `type`
  });

  it("loads a belt's match file path (existence verified, fn loaded later in buildDeps)", () => {
    const { repoDir } = setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    match: match.ts
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: { "match.ts": "export default () => true;\n" } },
    );
    expect(loadConfig("demo").config.belts[0]!.matchFile).toBe(join(repoDir, "match.ts"));
  });

  it("throws when a belt's match file is missing on disk", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    match: nope.ts
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/match not found/);
  });

  it("sorts belts by priority (ties keep config order)", () => {
    setup(
      cfg(`${JIRA_SRC}${LM_SRC}`, `  - name: low
    source: ideas
    priority: 5
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
  - name: high
    source: jira
    label: agent
    priority: 1
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
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
    source: nonexistent
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/unknown work source/);
  });

  it("rejects duplicate belt names", () => {
    setup(
      cfg(JIRA_SRC, `  - name: dup
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
  - name: dup
    source: jira
    label: agent2
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate belt name/);
  });

  it("rejects a belt on a label-driven source that sets no label (there is no default)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/there is no default/);
  });

  it("rejects a `label` on a belt whose source has no label concept (local_markdown)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    label: whatever
    steps:
      - { type: custom, name: research, prompt_file: r.md, prompt_file_source: config }
`),
      { prompts: { "r.md": "r\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/no label concept/);
  });

  it("loads a sentry source — no pickup label (belts route by match/priority) — with resolved defaults", () => {
    setup(
      cfg(SENTRY_SRC, `  - name: fix-errors
    source: sentry
    steps: [{ type: work }, { type: review }, { type: pr }]
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    const src = config.sources[0]!;
    expect(src.type).toBe("sentry");
    expect(src.name).toBe("sentry"); // default name = type
    const scfg = src.cfg as SentrySourceCfg;
    expect(scfg.organization).toBe("acme");
    expect(scfg.projects).toEqual(["backend"]);
    expect(scfg.environment).toEqual(["production"]); // single string normalized to a list
    expect(scfg.query).toBe("is:unresolved level:error");
    expect(scfg.baseUrl).toBe("https://sentry.io"); // default
    expect(scfg.statsPeriod).toBe("14d"); // default
    expect(scfg.onMerge).toBe("comment"); // default
    expect(config.belts[0]!.label).toBeUndefined(); // label-less, like local_markdown
  });

  it("rejects a `label` on a belt whose source is sentry (no label concept)", () => {
    setup(
      cfg(SENTRY_SRC, `  - name: fix-errors
    source: sentry
    label: nope
    steps: [{ type: work }, { type: review }, { type: pr }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/no label concept/);
  });

  it("rejects two belts that pick up the same source by the same label (contention)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: a
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
  - name: b
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/contend for the same items/);
  });

  it("allows ONE source split across belts by DISTINCT labels", () => {
    setup(
      cfg(JIRA_SRC, `  - name: bugs
    source: jira
    label: agent-bug
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
  - name: chores
    source: jira
    label: agent-chore
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts.map((b) => b.label)).toEqual(["agent-bug", "agent-chore"]);
  });

  it("rejects two steps of one belt targeting the same layout pane (the first dispatch renames it away)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: work, pane: agent }, { type: pr }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/target the same layout pane/);
  });

  it("allows two belts to reuse the same tab/pane labels (each run gets its own workspace)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: bugs
    source: jira
    label: agent-bug
    steps: [{ type: work, tab: work, pane: agent }, { type: pr }]
  - name: chores
    source: jira
    label: agent-chore
    steps: [{ type: work, tab: work, pane: agent }, { type: pr }]
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts.length).toBe(2);
  });

  it("rejects a belt with duplicate step names (name defaults to type — collide on two customs)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: a.md, prompt_file_source: config }
      - { type: custom, name: research, prompt_file: b.md, prompt_file_source: config }
`),
      { prompts: { "a.md": "a\n", "b.md": "b\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate step name/);
  });

  it("rejects a belt step with an invalid (non-slug) name", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: "Bad Name", prompt_file: a.md, prompt_file_source: config }
`),
      { prompts: { "a.md": "a\n" } },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a belt step referencing an unknown step type", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: teleport, tab: t, pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a custom step with no prompt_file (it has no built-in prompt)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/needs a prompt_file/);
  });

  it("rejects a belt whose required dataflow is unsatisfied (review with no upstream commits)", () => {
    // review requires `commits`; with no earlier work/pr step nothing produces them.
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: review, tab: review, pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/requires "commits"/);
  });

  it("throws when a custom belt step's prompt_file is missing on disk", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: missing.md, prompt_file_source: config }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/prompt_file.*not found/);
  });

  it("rejects a belt with no steps", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps: []
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a belt with no steps key at all", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a stray `belt_type` key (removed in the clean break)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized|belt_type/i);
  });

  it("rejects a stray `agents` block (removed in the clean break)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
    agents: { fix: { tab: fix, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized|agents/i);
  });

  it("rejects a step with tab but no pane (must be set together)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work, tab: work }
      - { type: review, tab: review, pane: agent }
      - { type: pr, tab: pr, pane: agent }
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
    source: ideas
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
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
    source: jira
    label: agent
    workspace_name: "fix/{{work_id}}-{{work_slug}}"
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts[0]!.workspaceName).toBe("fix/{{work_id}}-{{work_slug}}");
  });

  it("rejects a workspace_name template missing {{work_id}}", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    workspace_name: "fix/{{work_slug}}"
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
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
    // A belt is now one ordered steps[] list (no belt_type discriminated union). The step `type`
    // enum is generated from the step-primitive registry.
    const step = js.properties.belt.items.properties.steps.items;
    expect([...step.properties.type.enum].sort()).toEqual(["custom", "evidence", "pr", "review", "work"]);
    // the step-name slug regex survives into the schema
    expect(step.properties.name.pattern).toBeTruthy();
    // .strict() → additionalProperties:false, so editors flag unknown keys (a stray step key, or the
    // removed belt_type/agents on a belt).
    expect(step.additionalProperties).toBe(false);
    expect(js.properties.belt.items.additionalProperties).toBe(false);
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

describe("loadConfig — layouts (workspace-manager port)", () => {
  const WS = `  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
  // A belt that selects layouts: hotfix/* → hot, else the web default.
  const BELT = `  - name: ship
    source: jira
    label: agent
    default_layout: web
    layout_matching:
      - { worktree_pattern: "hotfix/*", layout: hot }
    steps:
      - { type: work,   tab: main,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;
  // A belt referencing only the `web` layout (for tests whose layout library omits `hot`).
  const BELT_WEB_ONLY = `  - name: ship
    source: jira
    label: agent
    default_layout: web
    steps:
      - { type: work,   tab: main,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;
  const LAYOUTS = `  - id: web
    setup: { command: pnpm i, blocking: true }
    tabs:
      - title: main
        panes:
          - { title: agent,  command: claude,  setup: true }
          - { title: editor, command: nvim, split: vertical, size: "30%" }
      - title: dev
        panes:
          - { title: server, command: pnpm dev, size: 0.5 }
          - { title: logs, split: horizontal, size: 40 }
  - id: hot
    tabs:
      - panes:
          - { command: claude }
`;
  const full = (belt = BELT, layouts = LAYOUTS) =>
    `repo:\n  path: __REPO__\nwork_sources:\n${WS}belt:\n${belt}layouts:\n${layouts}`;

  it("parses + normalizes the layout library and per-belt selection", () => {
    setup(full());
    const { config } = loadConfig("demo");
    expect(config.layouts.map((l) => l.id)).toEqual(["web", "hot"]);
    const web = config.layouts[0]!;
    expect(web.setup).toEqual({ command: "pnpm i", blocking: true });
    // vertical → right; "30%" → { percent: 30 }
    expect(web.tabs[0]!.panes[1]!.split).toBe("right");
    expect(web.tabs[0]!.panes[1]!.size).toEqual({ percent: 30 });
    // 0.5 fraction → percent 50; horizontal → down; 40 → cells
    expect(web.tabs[1]!.panes[0]!.size).toEqual({ percent: 50 });
    expect(web.tabs[1]!.panes[1]!.split).toBe("down");
    expect(web.tabs[1]!.panes[1]!.size).toEqual({ cells: 40 });
    const belt = config.belts[0]!;
    expect(belt.defaultLayout).toBe("web");
    expect(belt.layoutMatching).toEqual([{ worktreePattern: "hotfix/*", layout: "hot" }]);
  });

  it("rejects duplicate layout ids", () => {
    setup(full(BELT, `${LAYOUTS}  - id: web\n    tabs:\n      - panes:\n          - { command: x }\n`));
    expect(() => loadConfig("demo")).toThrow(/duplicate layout id "web"/);
  });

  it("rejects a belt default_layout that isn't a defined layout", () => {
    setup(full(BELT.replace("default_layout: web", "default_layout: ghost")));
    expect(() => loadConfig("demo")).toThrow(/default_layout "ghost" is not a defined layout/);
  });

  it("rejects a layout_matching rule referencing an unknown layout", () => {
    setup(full(BELT.replace("layout: hot", "layout: ghost")));
    expect(() => loadConfig("demo")).toThrow(/references unknown layout "ghost"/);
  });

  it("rejects a pane that sets both ratio and size", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { command: a }\n          - { split: right, ratio: 0.5, size: "30%" }\n`;
    setup(full(BELT_WEB_ONLY, bad));
    expect(() => loadConfig("demo")).toThrow(/either ratio or size/);
  });

  it("rejects more than one setup pane in a layout", () => {
    const bad = `  - id: web\n    setup: { command: x }\n    tabs:\n      - panes:\n          - { command: a, setup: true }\n          - { command: b, setup: true, split: right }\n`;
    setup(full(BELT_WEB_ONLY, bad));
    expect(() => loadConfig("demo")).toThrow(/at most one pane/);
  });

  it("rejects an out-of-range percentage size", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { command: a }\n          - { split: right, size: "150%" }\n`;
    setup(full(BELT_WEB_ONLY, bad));
    expect(() => loadConfig("demo")).toThrow(/between 0% and 100%/);
  });

  it("the shipped example config parses against the schema (guards example drift)", () => {
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const raw = readFileSync(join(repoRoot, "examples/example-repo/config.yml"), "utf8");
    const r = RepoConfigSchema.safeParse(parseYaml(raw));
    const detail = r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    expect(r.success, detail).toBe(true);
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
