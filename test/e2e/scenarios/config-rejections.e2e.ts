// Config mistakes must fail at LOAD, with an error that names what to fix — not at runtime, as a run
// that parks an hour later. The cross-field rules can't be expressed in the JSON schema, so they live
// in `config.ts` and are only reachable by actually loading a config.
//
// This table is also the contract the shipped skill quotes: every message here is one a user (or the
// agent reading the skill) will be shown, so a reworded rejection should break this on purpose.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

interface Case {
  what: string;
  /** Mutates an otherwise-valid config into the broken one. */
  break: (cfg: Record<string, any>) => void;
  /** A fragment the rejection must contain. */
  expect: RegExp;
}

/** A syntactically valid jira source — enough to reach the cross-field rules that only apply to a
 *  label-driven source. Nothing dials it: these rejections all happen at LOAD. */
const JIRA_SOURCE = { type: "jira", name: "board", jira: { base_url: "http://127.0.0.1:9", project: "APP", board: 1 } };

const CASES: Case[] = [
  {
    what: "a belt pointing at a source that isn't configured",
    break: (c) => void (c.belt[0].source = "nope"),
    expect: /source .*nope|unknown source|references/i,
  },
  {
    // Contention is only possible where a LABEL carves the queue up: two label-less belts on one
    // source are legitimate (priority + `match` disambiguate them — see belt-matrix).
    what: "two belts contending for the same (source, label)",
    break: (c) => {
      c.work_sources.push(JIRA_SOURCE);
      c.belt.push({ name: "one", source: "board", label: "agent", workspace_name: "a/{{work_id}}", steps: [{ type: "work" }] });
      c.belt.push({ name: "two", source: "board", label: "agent", workspace_name: "b/{{work_id}}", steps: [{ type: "work" }] });
    },
    expect: /contend|distinct label/i,
  },
  {
    what: "a belt on a label-driven source with no pickup label",
    break: (c) => {
      c.work_sources.push(JIRA_SOURCE);
      c.belt.push({ name: "unlabelled", source: "board", workspace_name: "u/{{work_id}}", steps: [{ type: "work" }] });
    },
    expect: /label/i,
  },
  {
    what: "a step with a tab but no pane",
    break: (c) => void (c.belt[0].steps[0].tab = "work"),
    expect: /tab.*pane|pane.*tab/i,
  },
  {
    what: "a workspace_name with no {{work_id}}",
    break: (c) => void (c.belt[0].workspace_name = "fixed-branch-name"),
    expect: /work_id/i,
  },
  {
    what: "a pickup label on a source that has no label concept",
    break: (c) => void (c.belt[0].label = "agent"),
    expect: /label/i,
  },
  {
    what: "a custom step with no prompt_file",
    break: (c) => void (c.belt[0].steps = [{ type: "custom", name: "thinking" }]),
    expect: /prompt_file/i,
  },
  {
    what: "prompt_mode: replace on a step that has no prompt_file",
    break: (c) => void (c.belt[0].steps = [{ type: "work", prompt_mode: "replace" }]),
    expect: /prompt_mode|replace/i,
  },
  {
    what: "a match predicate that doesn't exist on disk",
    break: (c) => void (c.belt[0].match = "no-such-match.ts"),
    expect: /match|no-such-match/i,
  },
  {
    what: "a step targeting a pane its belt's layout doesn't define",
    break: (c) => {
      c.layouts = [{ id: "only-work", tabs: [{ title: "work", panes: [{ title: "agent", agent: "claude" }] }] }];
      c.belt[0].default_layout = "only-work";
      c.belt[0].steps = [{ type: "work", tab: "work", pane: "agent" }, { type: "review", tab: "review", pane: "agent" }];
    },
    expect: /review|pane/i,
  },
  {
    what: "a belt whose step needs an input nothing upstream produces",
    break: (c) => void (c.belt[0].steps = [{ type: "review" }, { type: "pr" }]),
    expect: /commits|consumes|produce/i,
  },
];

scenario(
  {
    name: "config-rejections",
    timeoutMs: 180_000,
    briefs: {},
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const configPath = join(w.paths.repoConfigDir, "config.yml");
    const valid = () => ({
      repo: { path: w.paths.repo, base_ref: "origin/main", github: w.ghRepo },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: w.paths.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
    });

    // The baseline really is valid — otherwise every case below would "pass" for the wrong reason.
    writeFileSync(configPath, stringify(valid()));
    const ok = w.factory.cli(["doctor"]);
    expect(`${ok.stdout}${ok.stderr}`, "the unmodified config loads").toMatch(/✓ config loads/);

    const missed: string[] = [];
    for (const c of CASES) {
      const cfg = valid();
      c.break(cfg as Record<string, any>);
      writeFileSync(configPath, stringify(cfg));
      const out = w.factory.cli(["doctor"]);
      const text = `${out.stdout}${out.stderr}`;
      // Rejected at all…
      if (/✓ config loads/.test(text)) {
        missed.push(`${c.what} — was ACCEPTED`);
        continue;
      }
      // …and with a message that names the problem, not just "invalid".
      if (!c.expect.test(text)) missed.push(`${c.what} — rejected, but the message didn't match ${c.expect}: ${text.split("\n").find((l) => l.includes("✗")) ?? text.slice(0, 200)}`);
    }
    // Joined into the message on purpose: a failure has to say WHICH config was accepted, or the
    // scenario is useless to whoever reads the report.
    expect(missed.join("\n"), "every broken config must be rejected with a message that names the problem").toBe("");

    // A repo whose config no longer loads must not take the whole server down with it: the resident
    // process keeps answering, which is what lets `doctor` (and the TUI) tell you what to fix.
    writeFileSync(configPath, stringify(valid()));
    expect(await w.factory.health(), "the server stayed up through all of that").toBeTruthy();
  },
);
