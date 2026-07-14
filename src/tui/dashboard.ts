// Dashboard tab — per-repo view of the factory that also drives it. Repos come from disk
// (listConfiguredRepos); live status + eligible items come from the resident server (api.ts). Rows
// are navigable (↑↓); contextual keys act on the highlighted row, each behind the shell's
// confirmation modal:  t = tick a repo,  c = claim an eligible item,  x = teardown an active run,
// d = open repo detail + diagnostics, r = refresh, l = log in (OAuth). Auto-refreshes every 3s while
// active; when the server is down it lists the repos with a hint and actions no-op.
//
// Refresh is flicker-free: quick status paints first, eligible source queries fold in afterward, and
// both passes reconcile in place — reusing existing text renderables and only rewriting content or
// adding/removing rows at the tail.
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { listConfiguredRepos, loadConfig } from "../config.ts";
import type { JiraSourceCfg } from "../clients/jira-source.ts";
import { fetchEligible, fetchHealth, fetchStatus, fetchTimeline, postClaim, postTeardown, postTick, serverPort, type ActiveRun, type EligibleItem, type RepoStatus } from "./api.ts";
import { BORDER, theme } from "./theme.ts";
import type { ChooseFn, ConfirmFn, PromptFn, ShowInfoFn, TabView } from "./types.ts";

function fmtTime(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts; // tolerate seconds or milliseconds
  return new Date(ms).toLocaleString();
}

const REFRESH_MS = 3000;

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function runColor(run: ActiveRun): string {
  const o = (run.outcome ?? "").toLowerCase();
  const p = (run.phase ?? "").toLowerCase();
  // "attention" is the engine's needs-a-human state (stalled / over-budget / asked a human) — color
  // it (and failed/abandoned outcomes) red so it stands out as needing action.
  if (p === "attention" || /attention|stall|wait|human/.test(p) || /fail|error|abandon|block/.test(o) || /fail|error|block/.test(p)) return theme.status.bad;
  if (/review|pr|ci|merg/.test(p)) return theme.accent;
  return theme.text.primary;
}

type RowKind = "repo" | "run" | "eligible" | "source";
interface Target {
  repo: string;
  kind: RowKind;
  key?: string;
  source?: string | null;
  belt?: string;
}

/** Desired state of one line (built in memory, then reconciled onto the rendered nodes). */
interface LineSpec {
  content: string;
  fg: string;
  target?: Target; // present ⇒ focusable/actionable
}
/** A rendered line: its persistent text renderable + current spec. */
interface LineNode {
  text: TextRenderable;
  target?: Target;
  base: string;
  baseFg: string;
}

export function createDashboard(renderer: CliRenderer, actions: { confirm: ConfirmFn; choose: ChooseFn; showInfo: ShowInfoFn; prompt: PromptFn }): TabView {
  const { confirm, choose, showInfo, prompt } = actions;

  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.bg, paddingLeft: 1, paddingRight: 1 });
  const banner = new TextRenderable(renderer, { content: "loading…", fg: theme.text.secondary, height: 1, wrapMode: "none" });
  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    focusedBorderColor: theme.border.active,
    title: " status ",
    titleColor: theme.text.secondary,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const actionLine = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", fg: theme.text.tertiary, paddingLeft: 1 });
  root.add(banner);
  root.add(list);
  root.add(actionLine);

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let serverUp = false;
  let lines: LineNode[] = [];
  let rows: LineNode[] = []; // focusable subset of lines, in order
  let hi = 0; // index into rows
  const statusBelts = new Map<string, { name: string; beltType: string; source: string }[]>();

  const rowKey = (t: Target) => `${t.repo}|${t.kind}|${t.belt ?? ""}|${t.key ?? ""}`;
  const setAction = (msg: string, fg: string) => { actionLine.content = msg; actionLine.fg = fg; };

  function applyLine(l: LineNode, isHi: boolean): void {
    const gutter = l.target ? (isHi ? "▶ " : "  ") : "";
    l.text.content = gutter + l.base;
    l.text.fg = isHi && l.target ? theme.accent : l.baseFg;
  }
  function paint(): void {
    const cur = rows[hi];
    for (const l of lines) applyLine(l, l === cur);
    if (cur) list.scrollChildIntoView(cur.text.id);
  }
  function setHighlight(i: number): void {
    if (rows.length === 0) return;
    hi = Math.max(0, Math.min(i, rows.length - 1));
    paint();
  }

  /** Reconcile the rendered lines to `specs` by REUSING existing nodes (update content in place),
   *  adding/removing only the tail difference. No full teardown ⇒ no flicker. */
  function reconcile(specs: LineSpec[]): void {
    const prevKey = rows[hi]?.target ? rowKey(rows[hi]!.target!) : null;
    const shared = Math.min(specs.length, lines.length);
    for (let i = 0; i < shared; i++) {
      const l = lines[i]!;
      const s = specs[i]!;
      l.base = s.content;
      l.baseFg = s.fg;
      l.target = s.target;
    }
    if (specs.length > lines.length) {
      for (let i = lines.length; i < specs.length; i++) {
        const s = specs[i]!;
        const text = new TextRenderable(renderer, { content: "", fg: s.fg, width: "100%", height: 1, wrapMode: "none" });
        list.add(text);
        lines.push({ text, target: s.target, base: s.content, baseFg: s.fg });
      }
    } else if (specs.length < lines.length) {
      for (let i = lines.length - 1; i >= specs.length; i--) {
        const l = lines[i]!;
        list.remove(l.text.id);
        l.text.destroy();
      }
      lines.length = specs.length;
    }
    rows = lines.filter((l) => l.target);
    const idx = prevKey ? rows.findIndex((r) => rowKey(r.target!) === prevKey) : -1;
    hi = idx >= 0 ? idx : Math.max(0, Math.min(hi, rows.length - 1));
    paint();
  }

  function renderStatus(
    health: NonNullable<Awaited<ReturnType<typeof fetchHealth>>>,
    repos: string[],
    data: { name: string; st: RepoStatus | null; el: { eligible: EligibleItem[] } | null }[],
  ): void {
    serverUp = true;
    statusBelts.clear();
    banner.content = `● server up · v${health.version} · uptime ${fmtDuration(health.uptimeSec)}`;
    banner.fg = theme.status.good;
    const specs: LineSpec[] = [];
    for (const { name, st, el } of data) {
      if (st) statusBelts.set(name, st.belts);
      const active = st?.active ?? [];
      specs.push({ content: `${name}   active ${active.length}/${st?.limits.maxActiveWorkspaces ?? "?"}`, fg: theme.accent, target: { repo: name, kind: "repo" } });
      if (!st) {
        specs.push({ content: "  (status unavailable)", fg: theme.text.tertiary });
        continue;
      }
      const eligible = el?.eligible ?? [];
      for (const belt of st.belts) {
        const beltRuns = active.filter((r) => r.belt === belt.name);
        const beltEligible = eligible.filter((i) => i.belt === belt.name);
        if (beltRuns.length === 0 && beltEligible.length === 0) continue;
        specs.push({ content: `  ${belt.name}  [${belt.beltType}]`, fg: theme.text.secondary });
        for (const run of beltRuns) {
          const step = run.step ? `/${run.step}` : "";
          const pr = run.prNumber ? `  PR #${run.prNumber}` : "";
          const summary = run.summary ? `  ${run.summary}` : "";
          specs.push({ content: `    ${run.ticketKey}  ${run.phase}${step}${pr}${summary}`, fg: runColor(run), target: { repo: name, kind: "run", key: run.ticketKey, source: run.workSource } });
        }
        for (const item of beltEligible) {
          specs.push({ content: `    ${item.key}  eligible  ${item.summary}  (${item.type})`, fg: theme.text.secondary, target: { repo: name, kind: "eligible", key: item.key, source: item.source, belt: item.belt } });
        }
      }
      const unassigned = active.filter((r) => !st.belts.some((b) => b.name === r.belt));
      if (unassigned.length > 0) {
        specs.push({ content: "  unassigned", fg: theme.status.warn });
        for (const run of unassigned) {
          const step = run.step ? `/${run.step}` : "";
          const summary = run.summary ? `  ${run.summary}` : "";
          specs.push({ content: `    ${run.ticketKey}  ${run.phase}${step}${summary}`, fg: runColor(run), target: { repo: name, kind: "run", key: run.ticketKey, source: run.workSource } });
        }
      }
    }
    if (repos.length === 0) specs.push({ content: "  no repos configured under ~/.config/herdr-factory/repos", fg: theme.text.tertiary });
    reconcile(specs);
  }

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const health = await fetchHealth();
      if (timer === null) return; // deactivated mid-flight
      const repos = listConfiguredRepos();
      if (!health) {
        serverUp = false;
        statusBelts.clear();
        const specs: LineSpec[] = [];
        banner.content = "⚠ server not running — start it with `herdr-factory serve`";
        banner.fg = theme.status.warn;
        if (repos.length === 0) specs.push({ content: "  no repos configured under ~/.config/herdr-factory/repos", fg: theme.text.tertiary });
        for (const name of repos) specs.push({ content: `${name}   (server down)`, fg: theme.text.tertiary, target: { repo: name, kind: "repo" } });
        reconcile(specs);
        return;
      }

      // Start all repo and source requests together. Status is intentionally quick (no auth/AWS or
      // worker probes), so the hierarchy paints as soon as it arrives; slower eligible queries fold
      // in afterward without holding the first useful frame.
      const eligibleRequests = repos.map((name) => fetchEligible(name));
      const statuses = await Promise.all(repos.map((name) => fetchStatus(name)));
      if (timer === null) return;
      const data = repos.map((name, i) => ({ name, st: statuses[i] ?? null, el: null }));
      renderStatus(health, repos, data);

      const eligible = await Promise.all(eligibleRequests);
      if (timer === null) return;
      renderStatus(health, repos, repos.map((name, i) => ({ name, st: statuses[i] ?? null, el: eligible[i] ?? null })));
    } finally {
      inFlight = false;
    }
  }

  // ── actions (each confirmed; result shown on actionLine; then refresh) ────────────────────────
  async function doTick(repo: string): Promise<void> {
    if (!serverUp) return setAction("server not running", theme.status.warn);
    if (!(await confirm(`Run a reconcile tick on "${repo}"?`))) return;
    setAction(`ticking ${repo}…`, theme.text.secondary);
    const r = await postTick(repo);
    setAction(r.ok ? `✓ tick ran on "${repo}"` : `✗ tick failed: ${r.error}`, r.ok ? theme.status.good : theme.status.bad);
    void refresh();
  }

  async function doTeardown(t: Target): Promise<void> {
    if (!serverUp || !t.key) return;
    if (!(await confirm(`Tear down "${t.key}" (removes its worktree)?`))) return;
    setAction(`tearing down ${t.key}…`, theme.text.secondary);
    const r = await postTeardown(t.repo, t.key, t.source);
    setAction(r.ok ? `✓ torn down "${t.key}"` : `✗ teardown failed: ${r.error}`, r.ok ? theme.status.good : theme.status.bad);
    void refresh();
  }

  async function doClaim(t: Target): Promise<void> {
    if (!serverUp || !t.key) return;
    const belts = (statusBelts.get(t.repo) ?? []).filter((b) => b.source === t.source);
    let belt: string;
    if (t.belt) {
      belt = t.belt;
    } else if (belts.length === 0) {
      return setAction(`no belt configured for source "${t.source}"`, theme.status.warn);
    } else if (belts.length === 1) {
      belt = belts[0]!.name;
    } else {
      const pick = await choose(`Claim ${t.key} onto which belt?`, belts.map((b) => ({ label: `${b.name} [${b.beltType}]`, value: b.name })));
      if (!pick) return;
      belt = pick;
    }
    if (!(await confirm(`Claim "${t.key}" onto belt "${belt}"?`))) return;
    setAction(`claiming ${t.key}…`, theme.text.secondary);
    const r = await postClaim(t.repo, t.key, belt);
    setAction(r.ok ? `✓ claimed "${t.key}" onto "${belt}"` : `✗ claim failed: ${r.error}`, r.ok ? theme.status.good : theme.status.bad);
    void refresh();
  }

  /** Run the OAuth login for a red (unauthenticated) source, IN-PROCESS: open the browser, then
   *  capture the redirected URL through the shell's prompt modal (the https callback means we read
   *  the code back rather than auto-catch it). Tokens are saved to the local db; the auth light flips
   *  authenticated in the repo Detail modal. Only a jira `auth.method: oauth` source can log in this way — anything
   *  else (api_token / github_issues) is explained instead. */
  async function doLogin(t: Target): Promise<void> {
    if (!t.source) return;
    let cfg: JiraSourceCfg;
    let dbPath: string;
    let brokerUrl: string | undefined;
    try {
      const { config, env } = loadConfig(t.repo);
      const src = config.sources.find((s) => s.name === t.source);
      if (!src) return setAction(`✗ source "${t.source}" not in config`, theme.status.bad);
      if (src.type !== "jira" || (src.cfg as JiraSourceCfg).auth.method !== "oauth") {
        showInfo(`"${t.source}" doesn't use OAuth`, [
          "Only a jira source with `auth: { method: oauth }` signs in via the browser.",
          "An api_token source is fixed by setting its env credentials; github_issues uses the gh CLI.",
        ]);
        return;
      }
      cfg = src.cfg as JiraSourceCfg;
      dbPath = config.paths.dbPath;
      brokerUrl = env.JIRA_OAUTH_BROKER_URL;
    } catch (e) {
      return setAction(`✗ ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
    }
    const auth = cfg.auth as Extract<JiraSourceCfg["auth"], { method: "oauth" }>;
    const [{ codeFromPaste, jiraOAuthLogin, OAUTH_REDIRECT_URI, openBrowser, pollServerForCode }, { resolveJiraOAuthApp }, { openDb }, { Store }, { systemClock }] = await Promise.all([
      import("../auth/jira-login.ts"),
      import("../auth/jira-oauth.ts"),
      import("../db/index.ts"),
      import("../db/store.ts"),
      import("../types.ts"),
    ]);
    let app;
    try {
      app = resolveJiraOAuthApp({ clientId: auth.clientId, brokerUrl });
    } catch (e) {
      return setAction(`✗ ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
    }
    const db = openDb(dbPath);
    try {
      // Auto-capture via the resident server's https callback listener when it's up; else paste via
      // the shell's prompt modal (openssl-less server, etc.).
      const health = await fetchHealth();
      const port = serverPort();
      const getCode =
        port && health?.oauthCallback
          ? async ({ authUrl, state }: { authUrl: string; state: string }) => {
              await openBrowser(authUrl);
              setAction(`approve in your browser (click through the localhost warning) — waiting…`, theme.text.secondary);
              return pollServerForCode(port, state);
            }
          : async ({ authUrl, state }: { authUrl: string; state: string }) => {
              await openBrowser(authUrl);
              const v = await prompt("Approve in your browser, then paste the redirected URL here", `${OAUTH_REDIRECT_URI}?code=…`);
              if (v == null) throw new Error("login cancelled");
              return codeFromPaste(v, state);
            };
      setAction(`opening a browser to authenticate "${t.source}"…`, theme.text.secondary);
      const result = await jiraOAuthLogin({ store: new Store(db, systemClock), repo: t.repo, source: t.source, siteBaseUrl: cfg.baseUrl, app, scopes: auth.scopes, now: systemClock, getCode });
      setAction(`✓ ${t.source}: authenticated to ${result.cloudUrl}`, theme.status.good);
      void refresh();
    } catch (e) {
      setAction(`✗ login failed: ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
    } finally {
      db.close();
    }
  }

  async function doRepoLogin(t: Target): Promise<void> {
    let sources: string[];
    try {
      sources = loadConfig(t.repo).config.sources
        .filter((s) => s.type === "jira" && (s.cfg as JiraSourceCfg).auth.method === "oauth")
        .map((s) => s.name);
    } catch (e) {
      return setAction(`✗ ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
    }
    if (sources.length === 0) {
      showInfo(`${t.repo} — login`, ["No Jira OAuth sources are configured for this repo.", "API-token and GitHub authentication are managed through the repo env or gh CLI."]);
      return;
    }
    const source = sources.length === 1 ? sources[0]! : await choose("Log in to which source?", sources.map((name) => ({ label: name, value: name })));
    if (source) await doLogin({ repo: t.repo, kind: "source", source });
  }

  async function openDetail(t: Target): Promise<void> {
    if (!serverUp) return setAction("server not running", theme.status.warn);
    const modal = showInfo(`${t.repo} — Detail`, ["Loading repository detail and running diagnostics…"]);
    const [st, eligibleResult] = await Promise.all([fetchStatus(t.repo, true), fetchEligible(t.repo)]);
    if (!st) {
      modal.update(`${t.repo} — Detail`, ["✗ Could not load repository detail. The server did not return repo status."]);
      return;
    }
    const output: string[] = ["General diagnostics"];
    const sso = st.evidenceSso;
    if (!sso || sso.state === "na") output.push("  – AWS SSO: not configured");
    else output.push(`  ${sso.state === "ok" ? "✓" : "✗"} AWS SSO: ${sso.state === "ok" ? "ok" : sso.detail ?? "credentials unavailable"}`);
    for (const src of st.sources) {
      const auth = src.auth;
      const label = `${src.name} (${src.type})`;
      if (!auth || auth.state === "na") output.push(`  – ${label}: no authentication required`);
      else if (auth.state === "ok") output.push(`  ✓ ${label}: authenticated${auth.account ? ` as ${auth.account}` : ""}`);
      else output.push(`  ✗ ${label}: ${auth.detail ?? "not authenticated"}${auth.account ? ` (${auth.account})` : ""}`);
    }
    output.push("", "Belt diagnostics");
    const eligible = eligibleResult?.eligible ?? [];
    for (const belt of st.belts) {
      const activeCount = st.active.filter((run) => run.belt === belt.name).length;
      const eligibleCount = eligible.filter((item) => item.belt === belt.name).length;
      output.push(`${belt.name} [${belt.beltType}]`);
      output.push(`  source: ${belt.source} · priority: ${belt.priority}${belt.label ? ` · label: ${belt.label}` : ""}`);
      output.push(`  steps: ${belt.steps?.length ? belt.steps.join(" → ") : "none"}`);
      output.push(`  work: ${activeCount} active · ${eligibleCount} eligible`);
      if (!belt.diagnostic) output.push("  – health: diagnostic unavailable");
      else if (belt.diagnostic.state === "ok") output.push("  ✓ health: source and pickup configuration reachable");
      else output.push(`  ✗ health: ${belt.diagnostic.detail ?? "check failed"}`);
      output.push("");
    }
    if (st.belts.length === 0) output.push("  (none configured)");
    modal.update(`${t.repo} — Detail`, output);
  }

  async function openTimeline(t: Target): Promise<void> {
    if (!serverUp || !t.key) return;
    setAction(`loading timeline for ${t.key}…`, theme.text.secondary);
    const res = await fetchTimeline(t.repo, t.key);
    if (!res) return setAction(`✗ could not load timeline for ${t.key}`, theme.status.bad);
    const linesOut = res.timeline.map((e) => `${fmtTime(e.ts)}  ${e.type}${e.detail ? "  " + e.detail : ""}`);
    setAction("", theme.text.tertiary);
    showInfo(`${t.key} — timeline`, linesOut);
  }

  list.onKeyDown = (key: KeyEvent) => {
    if (rows.length === 0) return;
    const t = rows[hi]?.target;
    switch (key.name) {
      case "up":
        setHighlight(hi - 1);
        key.preventDefault();
        break;
      case "down":
        setHighlight(hi + 1);
        key.preventDefault();
        break;
      case "return":
      case "enter":
        if (t?.kind === "run") void openTimeline(t);
        key.preventDefault();
        break;
      case "t":
        if (t) void doTick(t.repo);
        key.preventDefault();
        break;
      case "x":
        if (t?.kind === "run") void doTeardown(t);
        key.preventDefault();
        break;
      case "c":
        if (t?.kind === "eligible") void doClaim(t);
        key.preventDefault();
        break;
      case "l":
        if (t?.kind === "repo") void doRepoLogin(t);
        key.preventDefault();
        break;
      case "d":
        if (t?.kind === "repo") void openDetail(t);
        key.preventDefault();
        break;
      case "r":
        void refresh();
        key.preventDefault();
        break;
    }
  };

  return {
    root,
    sectionCount: 1,
    focusSection(n: number) {
      if (n === 1) list.focus();
    },
    restoreFocus() {
      list.focus();
    },
    activate() {
      timer = setInterval(() => void refresh(), REFRESH_MS);
      void refresh();
    },
    deactivate() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
