// A WORLD is one hermetic universe for one scenario: its own HOME, herdr config + socket, factory
// config dir and state root, target checkout, bare origin, briefs folder, bin shims and artifact dir.
// Nothing outside `<root>/<id>` is touched, so a scenario can never see the operator's real install.
//
// The root is short on purpose (`/h/<id>` in the container): herdr's unix socket lives under the
// herdr config dir, and a long path overflows sun_path and kills the server at boot.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { Db } from "./db.ts";
import { Factory } from "./factory.ts";
import { HerdrServer, delay, tail } from "./herdr.ts";
import { GhFake, initialGhState } from "./gh-fake/state.ts";
import type { AgentScript, Driver, Lane, ScenarioSpec, Tier, WorldPaths } from "./types.ts";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HARNESS_DIR, "..", "..", "..");

const DEFAULT_GH_REPO = "acme/app";
let seq = 0;

function shortRoot(): string {
  const override = process.env.HF_E2E_ROOT?.trim();
  if (override) return override;
  // `/h` is created by the image; on a host run fall back to a still-short temp root.
  if (existsSync("/h")) return "/h";
  return "/tmp/hfe";
}

function artifactsRoot(): string {
  return process.env.HF_E2E_ARTIFACTS?.trim() || join(REPO_ROOT, "artifacts", "e2e", "local");
}

/** The REAL herdr binary, resolved to an absolute path. Load-bearing: the world's own `herdr`
 *  wrapper (first on PATH) execs this, so a bare "herdr" here would re-resolve to the wrapper and
 *  exec-loop forever. */
function resolveRealHerdr(): string {
  const explicit = process.env.HF_HERDR_REAL?.trim();
  if (explicit) return explicit;
  const r = spawnSync("bash", ["-lc", "command -v herdr"], { encoding: "utf8" });
  const found = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!found) throw new Error("herdr is not on PATH — the real lane needs the herdr binary (set HF_HERDR_REAL)");
  return found;
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env as Record<string, string> });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd} (${r.status}): ${r.stderr || r.stdout}`);
  }
}

/** Deep-merge one level: the scenario's `repo`/`limits`/`agent` blocks override keys, not blocks. */
function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (v && b && typeof v === "object" && typeof b === "object" && !Array.isArray(v) && !Array.isArray(b)) {
      out[k] = { ...(b as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface WaitOpts {
  /** Shown in the timeout message — always phrase it as the thing you expected to happen. */
  label?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Issue a tick every N ms while waiting (default: only when driver === "tick"). */
  tickEveryMs?: number;
}

export class World {
  readonly spec: ScenarioSpec;
  readonly id: string;
  readonly repoName: string;
  readonly lane: Lane;
  readonly tier: Tier;
  readonly driver: Driver;
  readonly paths: WorldPaths;
  readonly env: Record<string, string>;
  readonly herdr: HerdrServer;
  readonly factory: Factory;
  readonly gh: GhFake;
  readonly db: Db;
  readonly ghRepo = DEFAULT_GH_REPO;
  /** Harness-owned files also exported into the child env as HF_* (typed, so they read back safely). */
  readonly files: {
    agentScript: string;
    agentLogDir: string;
    agentStateDir: string;
    ghState: string;
    ghLog: string;
    herdrLog: string;
  };
  private started = false;

  constructor(spec: ScenarioSpec) {
    this.spec = spec;
    this.id = `w${(process.pid % 1000).toString(36)}${(seq++).toString(36)}`;
    this.repoName = spec.repoName ?? "app";
    this.lane = spec.lane ?? "real";
    this.tier = (process.env.HF_E2E_TIER as Tier) || spec.tier || "scripted";
    this.driver = spec.driver ?? "serve";

    const home = join(shortRoot(), this.id);
    this.paths = {
      home,
      repo: join(home, "repo"),
      origin: join(home, "origin.git"),
      briefs: join(home, "briefs"),
      configDir: join(home, ".config", "herdr-factory"),
      repoConfigDir: join(home, ".config", "herdr-factory", "repos", this.repoName),
      stateRoot: join(home, ".state", "herdr-factory"),
      bin: join(home, "bin"),
      art: join(artifactsRoot(), "scenarios", spec.name),
    };

    const port = 8800 + (seq % 100) + (process.pid % 500) * 2;
    const realHerdr = resolveRealHerdr();
    this.files = {
      agentScript: join(home, "agent-script.json"),
      agentLogDir: join(this.paths.art, "agent"),
      agentStateDir: join(home, "agent-state"),
      ghState: join(home, "gh-state.json"),
      ghLog: join(this.paths.art, "gh-calls.jsonl"),
      herdrLog: join(this.paths.art, "herdr-calls.jsonl"),
    };
    this.env = {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${this.paths.bin}:${process.env.PATH ?? ""}`,
      TERM: "xterm-256color",
      HERDR_FACTORY_CONFIG_DIR: this.paths.configDir,
      HERDR_FACTORY_STATE_ROOT: this.paths.stateRoot,
      HERDR_FACTORY_PORT: String(port),
      HERDR_FACTORY_AUTO_UPDATE: "0",
      HERDR_FACTORY_LAYOUT_STATE_DIR: join(this.paths.stateRoot, "layout-hook"),
      HERDR_BIN_PATH: join(this.paths.bin, "herdr"),
      HERDR_SOCKET_PATH: join(home, ".config", "herdr", "herdr.sock"),
      HF_HERDR_REAL: realHerdr,
      HF_HERDR_LOG: this.files.herdrLog,
      HF_AGENT_SCRIPT: this.files.agentScript,
      HF_AGENT_LOG_DIR: this.files.agentLogDir,
      HF_AGENT_STATE_DIR: this.files.agentStateDir,
      HF_GH_STATE: this.files.ghState,
      HF_GH_LOG: this.files.ghLog,
      HF_GH_REPO: this.ghRepo,
      HF_WORLD: this.id,
      GIT_AUTHOR_NAME: "Harness Agent",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Agent",
      GIT_COMMITTER_EMAIL: "harness@example.test",
      ...(spec.processEnv ?? {}),
    };

    this.herdr = new HerdrServer({
      bin: realHerdr,
      env: this.env,
      logPath: join(this.paths.art, "herdr-server.log"),
      callLog: this.files.herdrLog,
    });
    this.factory = new Factory({
      repoRoot: REPO_ROOT,
      repo: this.repoName,
      env: this.env,
      logPath: join(this.paths.art, "factory-serve.log"),
      stateRoot: this.paths.stateRoot,
      port,
    });
    this.gh = new GhFake({ statePath: this.files.ghState, logPath: this.files.ghLog });
    this.db = new Db(this.paths.stateRoot, this.repoName);
  }

  // ── construction ──────────────────────────────────────────────────────────────────────────────

  private layout(): void {
    rmSync(this.paths.home, { recursive: true, force: true });
    rmSync(this.paths.art, { recursive: true, force: true });
    for (const d of [
      this.paths.home,
      this.paths.repo,
      this.paths.briefs,
      this.paths.repoConfigDir,
      this.paths.stateRoot,
      this.paths.bin,
      this.paths.art,
      this.files.agentLogDir,
      this.files.agentStateDir,
      join(this.paths.home, ".config", "herdr"),
    ]) {
      mkdirSync(d, { recursive: true });
    }
  }

  /** The synthetic target repo: a MAIN checkout (never a linked worktree), `origin/main` resolvable
   *  from a local bare repo, `.memory/` ignored, and a CLAUDE.md the shipped prompts defer to. */
  private buildTargetRepo(): void {
    const r = this.paths.repo;
    run("git", ["init", "-q", "--initial-branch=main", "."], r, this.env);
    run("git", ["config", "user.email", "harness@example.test"], r, this.env);
    run("git", ["config", "user.name", "Harness"], r, this.env);
    writeFileSync(join(r, "README.md"), `# ${this.ghRepo}\n\nSynthetic target repo for the herdr-factory e2e harness.\n`);
    writeFileSync(
      join(r, "CLAUDE.md"),
      [
        "# Guidelines",
        "",
        "- Tests: `true` (this repo has none; the command exits 0).",
        "- Lint: `true`. Type-check: `true`.",
        "- Commit style: `type(scope): summary`.",
        "",
      ].join("\n"),
    );
    writeFileSync(join(r, ".gitignore"), ".memory/\n");
    for (const [rel, body] of Object.entries(this.spec.repoFiles ?? {})) {
      const p = join(r, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      if (rel.endsWith(".sh")) chmodSync(p, 0o755);
    }
    run("git", ["add", "-A"], r, this.env);
    run("git", ["commit", "-q", "-m", "chore: initial commit"], r, this.env);
    run("git", ["init", "-q", "--bare", this.paths.origin], this.paths.home, this.env);
    run("git", ["remote", "add", "origin", this.paths.origin], r, this.env);
    run("git", ["push", "-q", "-u", "origin", "main"], r, this.env);
  }

  /** World bin dir, FIRST on PATH: the fake gh, the scripted agent under two herdr kind names, and a
   *  herdr wrapper that records every argv the engine issues (the only way to observe notifications
   *  and pane display metadata) before exec'ing the real binary. */
  private writeShims(): void {
    const b = this.paths.bin;
    const agentImpl = join(HARNESS_DIR, "agent", "agent.cjs");
    // herdr identifies a pane's agent by the foreground process's **argv[0]** (verified: a wrapper
    // that runs `exec node agent.cjs` is never detected and `agent start` times out after 60s, while
    // `exec -a claude node agent.cjs` is adopted in ~3s). So the scripted agent is exec'd UNDER the
    // kind's own name rather than copied to it — which also keeps the implementation editable in
    // place instead of duplicated into every world.
    for (const kind of ["claude", "opencode"]) {
      writeFileSync(
        join(b, kind),
        ["#!/usr/bin/env bash", `export HF_AGENT_KIND=${kind}`, `exec -a ${kind} ${process.execPath} ${agentImpl} "$@"`, ""].join("\n"),
      );
      chmodSync(join(b, kind), 0o755);
    }
    const ghSrc = join(HARNESS_DIR, "gh-fake", "gh");
    copyFileSync(ghSrc, join(b, "gh"));
    chmodSync(join(b, "gh"), 0o755);

    writeFileSync(
      join(b, "herdr"),
      [
        "#!/usr/bin/env bash",
        "# Harness wrapper: record the argv the factory issued, then run the real herdr.",
        'if [ -n "${HF_HERDR_LOG:-}" ]; then',
        '  printf \'{"ts":%s,"argv":%s}\\n\' "$(date +%s%3N)" "$(printf \'%s\\n\' "$@" | jq -R . | jq -s -c .)" >> "$HF_HERDR_LOG" 2>/dev/null || true',
        "fi",
        'exec "${HF_HERDR_REAL:-herdr}" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(join(b, "herdr"), 0o755);
  }

  private writeConfig(): void {
    const base: Record<string, unknown> = {
      repo: { path: this.paths.repo, base_ref: "origin/main", github: this.ghRepo },
      limits: {
        tick_interval_seconds: 1,
        step_budget_seconds: 120,
        stall_seconds: 120,
        layout_wait_seconds: 15,
        attention_renotify_seconds: 3600,
        max_active_workspaces: 3,
        max_claims_per_tick: 10,
        reconcile_concurrency: 4,
      },
      agent: { command: "claude", flags: [] },
    };
    const cfg = mergeConfig(base, this.spec.config(this.paths));
    const yaml = `# yaml-language-server: $schema=../../config.schema.json\n${yamlStringify(cfg, { lineWidth: 0 })}`;
    writeFileSync(join(this.paths.repoConfigDir, "config.yml"), yaml);

    if (this.spec.env) {
      const body = Object.entries(this.spec.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      const p = join(this.paths.repoConfigDir, "env");
      writeFileSync(p, `${body}\n`);
      chmodSync(p, 0o600);
    }
    for (const [rel, body] of Object.entries(this.spec.configFiles ?? {})) {
      const p = join(this.paths.repoConfigDir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    for (const [key, body] of Object.entries(this.spec.briefs ?? {})) {
      writeFileSync(join(this.paths.briefs, `${key}.md`), body);
    }
    this.setAgentScript(this.spec.agent ?? {});
    writeFileSync(this.files.ghState, JSON.stringify(initialGhState({ repo: this.ghRepo }), null, 2));
    writeFileSync(
      join(this.paths.art, "world.json"),
      JSON.stringify({ id: this.id, lane: this.lane, tier: this.tier, driver: this.driver, paths: this.paths, port: this.factory.port }, null, 2),
    );
  }

  /** Swap the agent's behaviour mid-scenario (it re-reads the script every turn). */
  setAgentScript(script: AgentScript): void {
    writeFileSync(this.files.agentScript, JSON.stringify(script, null, 2));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.layout();
    this.buildTargetRepo();
    this.writeShims();
    this.writeConfig();

    if (this.lane !== "real") throw new Error(`lane "${this.lane}" is not implemented yet (M4)`);
    // Link before boot so the one-shot [[startup]] hook is registered too; if linking needs the
    // socket, retry once the server is up (a fresh world has no stale claims for the startup hook
    // to reap, so post-boot linking is equivalent for our purposes).
    const linkedEarly = this.herdr.linkPlugin(REPO_ROOT);
    await this.herdr.start();
    if (!linkedEarly && !this.herdr.linkPlugin(REPO_ROOT)) {
      throw new Error(`herdr plugin link failed:\n${this.herdr.cli(["plugin", "link", REPO_ROOT]).stderr}`);
    }
    if (this.driver === "serve") await this.factory.serve();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await this.factory.stop();
    } finally {
      await this.herdr.stop();
      this.db.close();
    }
    this.started = false;
  }

  /** Copy everything a post-mortem needs into the artifact dir; called on pass AND fail. */
  collect(): void {
    try {
      mkdirSync(this.paths.art, { recursive: true });
      if (this.db.exists()) copyFileSync(this.db.path, join(this.paths.art, "herdr-factory.db"));
      const cfg = join(this.paths.repoConfigDir, "config.yml");
      if (existsSync(cfg)) copyFileSync(cfg, join(this.paths.art, "config.yml"));
      const repoLogs = join(this.paths.stateRoot, this.repoName, "logs");
      if (existsSync(repoLogs)) cpSync(repoLogs, join(this.paths.art, "repo-logs"), { recursive: true });
      const inbox = join(this.paths.briefs, ".herdr-factory-human");
      if (existsSync(inbox)) cpSync(inbox, join(this.paths.art, "human-inbox"), { recursive: true });
      // herdr logs to files in its own config dir, not to the stdout we pipe — and those logs are
      // where a failed adoption / layout apply actually explains itself.
      for (const name of ["herdr-server.log", "herdr-client.log", "herdr.log"]) {
        const p = join(this.paths.home, ".config", "herdr", name);
        if (existsSync(p)) copyFileSync(p, join(this.paths.art, `herdr-${name}`));
      }
      writeFileSync(join(this.paths.art, "state-dump.txt"), this.db.dump());
      writeFileSync(join(this.paths.art, "plugin-log.txt"), this.herdr.pluginLog());
    } catch (e) {
      writeFileSync(join(this.paths.art, "collect-error.txt"), String(e));
    }
    if (process.env.HF_E2E_KEEP !== "1") rmSync(this.paths.home, { recursive: true, force: true });
  }

  // ── driving + waiting ─────────────────────────────────────────────────────────────────────────

  tick(): Promise<void> {
    return this.factory.tick();
  }

  /** Poll until `pred` is true. Under `driver: "serve"` the server ticks itself (interval 1s), so
   *  this is a pure poll; under `driver: "tick"` it issues the passes. Every failure prints the run
   *  state, the last events, the engine's own log and the agent transcript — the harness lives or
   *  dies on this message. */
  async waitFor(pred: () => boolean | Promise<boolean>, opts: WaitOpts = {}): Promise<void> {
    const label = opts.label ?? "condition";
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const pollMs = opts.pollMs ?? 250;
    const tickEvery = opts.tickEveryMs ?? (this.driver === "tick" ? 500 : 0);
    const deadline = Date.now() + timeoutMs;
    let lastTick = 0;
    for (;;) {
      if (await pred()) return;
      if (Date.now() >= deadline) throw new Error(this.diagnose(`timed out after ${timeoutMs}ms waiting for: ${label}`));
      if (tickEvery && Date.now() - lastTick > tickEvery) {
        lastTick = Date.now();
        await this.tick().catch(() => undefined);
      }
      await delay(pollMs);
    }
  }

  /** Wait for a run to reach a phase (optionally with an outcome). */
  waitForPhase(key: string, phase: string, opts: WaitOpts = {}): Promise<void> {
    return this.waitFor(() => this.db.run(key)?.phase === phase, { label: `run ${key} phase=${phase}`, ...opts });
  }

  waitForEvent(key: string, type: string, opts: WaitOpts = {}): Promise<void> {
    return this.waitFor(() => this.db.eventTypes(key).includes(type), { label: `run ${key} event ${type}`, ...opts });
  }

  waitForEnd(key: string, outcome?: string, opts: WaitOpts = {}): Promise<void> {
    return this.waitFor(
      () => {
        const r = this.db.run(key);
        return !!r?.ended_at && (outcome === undefined || r.outcome === outcome);
      },
      { label: `run ${key} ended${outcome ? ` with outcome=${outcome}` : ""}`, ...opts },
    );
  }

  diagnose(headline: string): string {
    const parts = [
      `${headline}`,
      "",
      `— world ${this.id} (lane=${this.lane} tier=${this.tier} driver=${this.driver}) port=${this.factory.port}`,
      "",
      "— DB state —",
      this.db.dump(),
      "",
      "— engine log (tail) —",
      this.factory.repoLog(40),
      "",
      "— serve log (tail) —",
      this.factory.serveLog(20),
      "",
      "— agent transcript (tail) —",
      tail(join(this.files.agentLogDir, "agent.log"), 40),
      "",
      "— herdr agents —",
      JSON.stringify(this.herdr.agents(), null, 1),
      "",
      "— pane screens —",
      this.herdr
        .workspaces()
        .filter((ws) => (ws.worktree?.checkout_path ?? "") !== this.paths.repo)
        .map((ws) => this.herdr.screens(ws.workspace_id))
        .join("\n"),
    ];
    return parts.join("\n");
  }

  /** The scripted agent's transcript: every turn, every command it ran, and every rejection it saw. */
  agentLog(lines = 500): string {
    return tail(join(this.files.agentLogDir, "agent.log"), lines);
  }

  /** The rendered prompt a step was actually handed (asserting on prompts is a first-class use). */
  renderedPrompt(step: string, pass = 1): string | null {
    const p = join(this.files.agentLogDir, `prompt-${step}-pass${pass}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** The local_markdown human inbox: `<briefs>/.herdr-factory-human/<key>-q<id>.md` + `-notes.md`. */
  humanInbox(file: string): string | null {
    const p = join(this.paths.briefs, ".herdr-factory-human", file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  answerHumanQuestion(key: string, answer: string): void {
    const dir = join(this.paths.briefs, ".herdr-factory-human");
    const q = this.db.humanQuestions().find((h) => h.ticket_key === key && h.status === "pending") as
      | { id: number; external_id?: string }
      | undefined;
    const file = q?.external_id ?? join(dir, `${key}-q${q?.id ?? 1}.md`);
    const body = readFileSync(file, "utf8");
    writeFileSync(file, `${body.replace(/_Write the answer below this line[\s\S]*?_/, "")}\n${answer}\n`);
  }

  /** Local git facts about the target repo (branch cleanup, pushed refs, commits). */
  git(args: string[], cwd = this.paths.repo): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: this.env });
    return (r.stdout ?? "").trim();
  }

  branchExists(branch: string): boolean {
    return this.git(["branch", "--list", branch]) !== "";
  }
}
