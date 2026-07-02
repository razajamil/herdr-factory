// Dashboard tab — per-repo view of the factory that also drives it. Repos come from disk
// (listConfiguredRepos); live status + eligible items come from the resident server (api.ts). Rows
// are navigable (↑↓); contextual keys act on the highlighted row, each behind the shell's
// confirmation modal:  t = tick a repo,  c = claim an eligible item,  x = teardown an active run,
// r = refresh. Auto-refreshes every 3s while active; when the server is down it lists the repos with
// a hint and actions no-op.
//
// Refresh is flicker-free: it fetches ALL data first (no UI mutation while awaiting), then reconciles
// in place — reusing the existing text renderables and only rewriting their content, adding/removing
// rows at the tail. Unchanged lines are never destroyed, so the terminal just updates the glyphs
// that actually changed.
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { listConfiguredRepos } from "../config.ts";
import { fetchEligible, fetchHealth, fetchStatus, postClaim, postTeardown, postTick, type ActiveRun, type EligibleItem, type RepoStatus } from "./api.ts";
import { BORDER, theme } from "./theme.ts";
import type { ChooseFn, ConfirmFn, TabView } from "./types.ts";

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
  if (/fail|error|abandon|block/.test(o) || /fail|error|block/.test(p)) return theme.status.bad;
  if (/attention|stall|wait|human/.test(p)) return theme.status.warn;
  if (/review|pr|ci|merg/.test(p)) return theme.accent;
  return theme.text.primary;
}

type RowKind = "repo" | "run" | "eligible";
interface Target {
  repo: string;
  kind: RowKind;
  key?: string;
  source?: string | null;
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

export function createDashboard(renderer: CliRenderer, actions: { confirm: ConfirmFn; choose: ChooseFn }): TabView {
  const { confirm, choose } = actions;

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

  const rowKey = (t: Target) => `${t.repo}|${t.kind}|${t.key ?? ""}`;
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

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const health = await fetchHealth();
      if (timer === null) return; // deactivated mid-flight
      const repos = listConfiguredRepos();
      // Gather everything first — no UI mutation while we await, so no partial/empty frames.
      const data: { name: string; st: RepoStatus | null; el: { eligible: EligibleItem[] } | null }[] = [];
      if (health) {
        for (const name of repos) {
          const st = await fetchStatus(name);
          if (timer === null) return;
          const el = await fetchEligible(name);
          if (timer === null) return;
          data.push({ name, st, el });
        }
      }

      // ── synchronous UI update from here (single frame) ──
      serverUp = !!health;
      statusBelts.clear();
      const specs: LineSpec[] = [];
      if (!health) {
        banner.content = "⚠ server not running — start it with `herdr-factory serve`";
        banner.fg = theme.status.warn;
        if (repos.length === 0) specs.push({ content: "  no repos configured under ~/.config/herdr-factory/repos", fg: theme.text.tertiary });
        for (const name of repos) specs.push({ content: `${name}   (server down)`, fg: theme.text.tertiary, target: { repo: name, kind: "repo" } });
      } else {
        banner.content = `● server up · v${health.version} · uptime ${fmtDuration(health.uptimeSec)}`;
        banner.fg = theme.status.good;
        for (const { name, st, el } of data) {
          if (st) statusBelts.set(name, st.belts);
          const active = st?.active ?? [];
          const belts = st ? st.belts.map((b) => b.name).join(", ") || "—" : "—";
          specs.push({ content: `${name}   active ${active.length}/${st?.limits.maxActive ?? "?"}   belts: ${belts}`, fg: theme.accent, target: { repo: name, kind: "repo" } });
          if (!st) {
            specs.push({ content: "  (status unavailable)", fg: theme.text.tertiary });
            continue;
          }
          if (active.length === 0) specs.push({ content: "  idle — no active runs", fg: theme.text.tertiary });
          for (const run of active) {
            const step = run.step ? `/${run.step}` : "";
            const pr = run.prNumber ? `  PR #${run.prNumber}` : "";
            const summary = run.summary ? `  ${run.summary}` : "";
            specs.push({ content: `  ${run.ticketKey}  ${run.phase}${step}${pr}${summary}`, fg: runColor(run), target: { repo: name, kind: "run", key: run.ticketKey, source: run.workSource } });
          }
          const elig = el?.eligible ?? [];
          if (elig.length > 0) {
            specs.push({ content: "  eligible:", fg: theme.text.tertiary });
            for (const item of elig) specs.push({ content: `    ${item.key}  ${item.summary}  (${item.type})`, fg: theme.text.secondary, target: { repo: name, kind: "eligible", key: item.key, source: item.source } });
          }
        }
      }
      reconcile(specs);
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
    if (belts.length === 0) return setAction(`no belt configured for source "${t.source}"`, theme.status.warn);
    if (belts.length === 1) {
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
