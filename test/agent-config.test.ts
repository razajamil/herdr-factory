// The configurable agent harness (`agent: {command, flags}`) at the SPAWN site: the argv a
// factory-spawned pane launches (step.ts), the herdr agent kind derived from it (herdr.ts), and the
// PR-watch resolver's harness (watch.ts). Config-level RESOLUTION (repo/belt/step precedence) lives
// in config.test.ts's "agent: harness block"; this file pins the runtime behavior that consumes it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentKindForArgv } from "../src/clients/herdr.ts";
import { agentNameFor } from "../src/core/step.ts";
import { dispatchToLayout } from "../src/core/step.ts";
import { wakeResolver } from "../src/core/watch.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/types.ts";
import type { AgentConfig, Run } from "../src/types.ts";
import type { BeltRuntime, Deps } from "../src/core/deps.ts";

describe("agentKindForArgv — the herdr `agent start <name>` kind", () => {
  it("uses the executable's basename so a configured harness is detected", () => {
    expect(agentKindForArgv(["claude", "--dangerously-skip-permissions", "P"])).toBe("claude");
    expect(agentKindForArgv(["opencode", "P"])).toBe("opencode");
    expect(agentKindForArgv(["codex", "--yolo", "P"])).toBe("codex");
  });

  it("strips a full path down to the binary name", () => {
    expect(agentKindForArgv(["/opt/homebrew/bin/claude", "P"])).toBe("claude");
  });

  it("falls back to claude for an empty/absent argv[0]", () => {
    expect(agentKindForArgv([])).toBe("claude");
    expect(agentKindForArgv([""])).toBe("claude");
  });
});

describe("agentNameFor — herdr's agent-name rule for a factory-spawned pane", () => {
  // herdr rejects anything outside [a-z][a-z0-9_-]{0,31} with `invalid_agent_name`, so the run's own
  // `<step>:<KEY>` (uppercase key, a colon) can never be used as the agent name — it is published as
  // pane DISPLAY metadata instead.
  it("lowercases and hyphenates a step + work key", () => {
    expect(agentNameFor("work", "RWR-18147")).toBe("work-rwr-18147");
    expect(agentNameFor("fix", "K-1")).toBe("fix-k-1");
  });
  it("only ever emits a name herdr accepts", () => {
    for (const [step, key] of [
      ["work", "PROJ#42"],
      ["review", "a/b c"],
      ["evidence", "GH-999999999999999999999999999999999999"],
      ["1st_step", "K-1"],
    ]) {
      expect(agentNameFor(step!, key!)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
  });
});

describe("dispatchToLayout — spawned-pane argv is [command, ...flags, prompt]", () => {
  /** A minimal Deps that captures the argv agentStart is called with (the only thing under test on
   *  the dedicated-spawn path: no tab/pane, no known pane → agentStart is the single pane-creator). */
  function capturingDeps() {
    const captured: { argv?: string[]; name?: string; kind?: string } = {};
    const herdr = {
      paneAlive: async () => false,
      agentStart: async (o: { argv: string[]; name?: string; kind?: string }) => {
        captured.argv = o.argv;
        captured.name = o.name;
        captured.kind = o.kind;
        return "w1:p1";
      },
      reportPaneDisplay: async () => {},
    };
    const deps = { herdr, log: () => {}, sleep: async () => {}, config: { repoName: "demo" } } as unknown as Deps;
    return { deps, captured };
  }

  const dispatch = (deps: Deps, agent: AgentConfig) =>
    dispatchToLayout(deps, { workspaceId: "w1", worktree: "/wt", prompt: "PROMPT", step: "work", ticketKey: "K", agent });

  it("is byte-identical to the historical claude harness with no `agent:` block (default)", async () => {
    const { deps, captured } = capturingDeps();
    const r = await dispatch(deps, DEFAULT_AGENT_CONFIG);
    expect(r).toEqual({ status: "ready", paneId: "w1:p1" });
    expect(captured.argv).toEqual(["claude", "--dangerously-skip-permissions", "PROMPT"]);
  });

  it("threads a configured command with no flags (opencode acceptance)", async () => {
    const { deps, captured } = capturingDeps();
    await dispatch(deps, { command: "opencode", flags: [] });
    expect(captured.argv).toEqual(["opencode", "PROMPT"]);
  });

  it("threads a configured command WITH flags, in order", async () => {
    const { deps, captured } = capturingDeps();
    await dispatch(deps, { command: "codex", flags: ["--sandbox", "read-only"] });
    expect(captured.argv).toEqual(["codex", "--sandbox", "read-only", "PROMPT"]);
  });
});

describe("wakeResolver — the PR-watch resolver uses the pr step's (else repo's) harness", () => {
  const tmps: string[] = [];
  afterAll(() => {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  });
  function mkWorktree() {
    const wt = mkdtempSync(join(tmpdir(), "cats-resolver-"));
    tmps.push(wt);
    return wt;
  }

  /** Deps capturing the resolver spawn argv. `belt` is what resolveBelt returns; `repoAgent` is the
   *  config-level fallback. run.paneId is null so wakeResolver takes the fresh-spawn (agentStart) path. */
  function resolverDeps(belt: BeltRuntime | undefined, repoAgent: AgentConfig) {
    const captured: { argv?: string[] } = {};
    const herdr = {
      paneAlive: async () => false,
      agentStart: async (o: { argv: string[] }) => {
        captured.argv = o.argv;
        return "w1:pR";
      },
      reportPaneDisplay: async () => {},
    };
    const deps = {
      herdr,
      store: { updateRun: () => {} },
      resolveBelt: () => belt,
      resolveSource: () => undefined,
      config: { agent: repoAgent, paths: { repoDir: tmpdir() } },
      log: () => {},
    } as unknown as Deps;
    return { deps, captured };
  }

  const runOn = (worktree: string): Run =>
    ({ id: 1, ticketKey: "K", worktreePath: worktree, workspaceId: "w1", paneId: null, belt: "ship", workSource: "jira" }) as unknown as Run;

  it("uses the pr step's agent (the step that opensPr)", async () => {
    const belt = {
      steps: [
        { opensPr: false, agent: { command: "work-agent", flags: [] } },
        { opensPr: true, agent: { command: "codex", flags: ["--yolo"] } },
      ],
    } as unknown as BeltRuntime;
    const { deps, captured } = resolverDeps(belt, DEFAULT_AGENT_CONFIG);
    const ok = await wakeResolver(deps, runOn(mkWorktree()), 42);
    expect(ok).toBe(true);
    expect(captured.argv?.slice(0, 2)).toEqual(["codex", "--yolo"]); // pr step's harness
    expect(captured.argv?.at(-1)).toContain("prompt-resolver.md"); // the "read it" instruction is last
  });

  it("falls back to the repo agent when the belt can't be resolved", async () => {
    const { deps, captured } = resolverDeps(undefined, { command: "opencode", flags: [] });
    await wakeResolver(deps, runOn(mkWorktree()), 7);
    expect(captured.argv?.[0]).toBe("opencode");
    expect(captured.argv).toHaveLength(2); // opencode + the instruction, no stray flags
  });
});
