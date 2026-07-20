// Dashboard tab — per-repo view of the factory that also drives it. Repos come from disk
// (listConfiguredRepos); live status + eligible items come from the resident server (api.ts). Rows
// are navigable (↑↓); contextual keys act on the highlighted row, each behind the shell's
// confirmation modal:  t = tick a repo,  c = claim an eligible item,  x = teardown an active run,
// d = open repo detail + diagnostics, r = refresh. Auto-refreshes every 3s while
// active; when the server is down it lists the repos with a hint and actions no-op.
//
// Refresh is flicker-free: quick status paints first, eligible source queries fold in afterward, and
// both passes reconcile in place — reusing existing text renderables and only rewriting content or
// adding/removing rows at the tail. The quick paint carries the last good eligible items forward
// (eligibleCache) instead of blanking them, so the rows survive the phase-1 gap and a lagging or
// failed fold-in rather than blinking out for a frame.
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { hoverable, text } from "./render.ts";
import { listConfiguredRepos } from "../config-paths.ts";
import { fetchEligible, fetchHealth, fetchStatus, fetchTimeline, postClaim, postTeardown, postTick, serverPort, type ActiveRun, type EligibleItem, type RepoStatus } from "./api.ts";
import { foldEligible, withoutClaimed } from "./eligible-cache.ts";
import { updateWarning } from "../watchers/updater.ts";
import { BORDER, theme } from "./theme.ts";
import type { ChooseFn, ConfirmFn, PromptFn, ShowInfoFn, TabView } from "./types.ts";
import { formatWorkTable, type WorkTableRow } from "./work-table.ts";
import { formatWorkItemDetail } from "./work-detail.ts";

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
  // A background problem (e.g. a stuck evidence upload) — amber, so it stands out without shouting like
  // the red needs-a-human states. Attention/failure above still win.
  if (run.problem) return theme.status.warn;
  if (/review|pr|ci|merg/.test(p)) return theme.accent;
  return theme.text.primary;
}

function runStepStatuses(run: ActiveRun, steps: string[]): string[] {
  return steps.map((step) => {
    const state = run.steps.find((item) => item.step === step);
    if (state?.done) return "done";
    if (run.step === step) return run.phase;
    return "pending";
  });
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
  const banner = text(renderer, { content: "loading…", fg: theme.text.secondary, height: 1, wrapMode: "none" });
  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    focusedBorderColor: theme.border.active,
    title: " Status ",
    titleColor: theme.text.secondary,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const actionLine = text(renderer, { content: "", height: 1, wrapMode: "none", fg: theme.text.tertiary, paddingLeft: 1 });
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
  // Last SUCCESSFUL eligible result per repo, carried into the quick paint and across a failed
  // fold-in so the eligible rows never blink out for a frame (see eligible-cache.ts).
  const eligibleCache = new Map<string, { eligible: EligibleItem[] }>();

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
        const t = text(renderer, { content: "", fg: s.fg, width: "100%", height: 1, wrapMode: "none" });
        list.add(t);
        const node: LineNode = { text: t, target: s.target, base: s.content, baseFg: s.fg };
        // Click a row to highlight it; click the highlighted run row again to open its timeline. Nodes
        // are reused across reconciles (target reassigned), so resolve the row index at click time.
        t.onMouseDown = (e) => {
          const idx = rows.indexOf(node);
          if (idx < 0) return; // a non-focusable line (header/divider) — nothing to select
          const wasCurrent = list.focused && rows[hi] === node;
          list.focus();
          setHighlight(idx);
          if (wasCurrent && node.target?.kind === "run") void openTimeline(node.target);
          e.stopPropagation();
        };
        // Hover tint, but only on focusable rows (headers/dividers reuse the same nodes) — gate at
        // event time since a node's target is reassigned across reconciles.
        hoverable(t, theme.bg, () => rows.indexOf(node) >= 0);
        lines.push(node);
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
    // A warn-worthy last auto-update (failed / dirty-skip / behind its channel target) rides on the
    // banner in amber — the same signal the Doctor tab paints, surfaced on the main view too.
    const updateNote = updateWarning();
    banner.content = `● server up · v${health.version} · uptime ${fmtDuration(health.uptimeSec)}${updateNote ? ` · ⚠ ${updateNote}` : ""}`;
    banner.fg = updateNote ? theme.status.warn : theme.status.good;
    const specs: LineSpec[] = [];
    for (const { name, st, el } of data) {
      if (st) statusBelts.set(name, st.belts);
      const active = st?.active ?? [];
      specs.push({ content: `${name}   active ${active.length}/${st?.limits.maxActiveWorkspaces ?? "?"}`, fg: theme.accent, target: { repo: name, kind: "repo" } });
      if (!st) {
        specs.push({ content: "  (status unavailable)", fg: theme.text.tertiary });
        continue;
      }
      // Filter carried-forward eligible items against current runs: one may have been claimed since
      // the last successful fold-in, and would otherwise show as both a running and an eligible row.
      const eligible = withoutClaimed(el?.eligible ?? [], active);
      for (const belt of st.belts) {
        const beltRuns = active.filter((r) => r.belt === belt.name);
        const beltEligible = eligible.filter((i) => i.belt === belt.name);
        if (beltRuns.length === 0 && beltEligible.length === 0) continue;
        specs.push({ content: `  ${belt.name}  [${belt.beltType}]`, fg: theme.text.secondary });
        const tableRows: WorkTableRow[] = [
          ...beltRuns.map((run) => ({ id: run.ticketKey, description: run.summary, statuses: runStepStatuses(run, belt.steps) })),
          ...beltEligible.map((item) => ({ id: item.key, description: item.summary, statuses: belt.steps.map((_, index) => index === 0 ? "eligible" : "pending") })),
        ];
        const table = formatWorkTable(belt.steps, tableRows);
        specs.push({ content: `    ${table.header}`, fg: theme.text.tertiary });
        specs.push({ content: `    ${table.divider}`, fg: theme.text.tertiary });
        table.rows.forEach((content, index) => {
          const run = beltRuns[index];
          if (run) {
            const marker = run.problem ? `  ⚠ ${run.problem.detail}` : "";
            specs.push({ content: `  ${content}${marker}`, fg: runColor(run), target: { repo: name, kind: "run", key: run.ticketKey, source: run.workSource } });
            return;
          }
          const item = beltEligible[index - beltRuns.length]!;
          specs.push({ content: `  ${content}`, fg: theme.text.secondary, target: { repo: name, kind: "eligible", key: item.key, source: item.source, belt: item.belt } });
        });
      }
      const unassigned = active.filter((r) => !st.belts.some((b) => b.name === r.belt));
      if (unassigned.length > 0) {
        specs.push({ content: "  unassigned", fg: theme.status.warn });
        for (const run of unassigned) {
          const step = run.step ? `/${run.step}` : "";
          const summary = run.summary ? `  ${run.summary}` : "";
          const marker = run.problem ? `  ⚠ ${run.problem.detail}` : "";
          specs.push({ content: `    ${run.ticketKey}  ${run.phase}${step}${summary}${marker}`, fg: runColor(run), target: { repo: name, kind: "run", key: run.ticketKey, source: run.workSource } });
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
      // Quick paint carries the last good eligible items (eligibleCache) rather than blanking them, so
      // the rows survive the phase-1 gap before the fold-in — the flicker in the recording.
      renderStatus(health, repos, repos.map((name, i) => ({ name, st: statuses[i] ?? null, el: eligibleCache.get(name) ?? null })));

      const eligible = await Promise.all(eligibleRequests);
      if (timer === null) return;
      // Fold fresh results in (keeping the last good value where a query failed/timed out), then paint.
      foldEligible(eligibleCache, repos, eligible);
      renderStatus(health, repos, repos.map((name, i) => ({ name, st: statuses[i] ?? null, el: eligibleCache.get(name) ?? null })));
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
      output.push(`${belt.name} [${belt.beltType}]${belt.active === false ? " — INACTIVE" : ""}`);
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

  const timelineLine = (e: { ts: number; type: string; detail: string | null }) =>
    `${fmtTime(e.ts)}  ${e.type}${e.detail ? "  " + e.detail : ""}`;

  async function openTimeline(t: Target): Promise<void> {
    if (!serverUp || !t.key) return;
    setAction(`loading timeline for ${t.key}…`, theme.text.secondary);
    const res = await fetchTimeline(t.repo, t.key);
    if (!res) return setAction(`✗ could not load timeline for ${t.key}`, theme.status.bad);
    setAction("", theme.text.tertiary);
    showInfo(`${t.key} — timeline`, res.timeline.map(timelineLine));
  }

  /** Full read-only detail for one active work item: overview + belt step progress + timeline. Pulls a
   *  fresh detailed status (so the live worker/pane state is populated, unlike the quick refresh loop)
   *  alongside the timeline; degrades to just the timeline if the run has ended in the meantime. */
  async function openWorkItemDetail(t: Target): Promise<void> {
    if (!serverUp || !t.key) return;
    const title = `${t.key} — detail`;
    const modal = showInfo(title, ["Loading work item detail…"]);
    const [st, tl] = await Promise.all([fetchStatus(t.repo, true), fetchTimeline(t.repo, t.key)]);
    const timelineLines = (tl?.timeline ?? []).map(timelineLine);
    const run = st?.active.find((r) => r.ticketKey === t.key && (!t.source || r.workSource === t.source));
    if (!run) {
      modal.update(title, [
        "(run is no longer active — showing its timeline)",
        "",
        "Timeline",
        ...(timelineLines.length ? timelineLines.map((l) => `  ${l}`) : ["  (no events)"]),
      ]);
      return;
    }
    const belt = st!.belts.find((b) => b.name === run.belt);
    modal.update(title, formatWorkItemDetail(
      {
        key: run.ticketKey,
        summary: run.summary,
        issueType: run.issueType,
        workSource: run.workSource,
        belt: run.belt,
        branch: run.branch,
        phase: run.phase,
        step: run.step,
        prNumber: run.prNumber,
        outcome: run.outcome,
        worker: run.worker,
        attentionReason: run.attentionReason,
        problem: run.problem ? { detail: run.problem.detail } : null,
        createdAt: run.createdAt,
        beltSteps: belt?.steps ?? [],
        steps: run.steps.map((s) => ({ step: s.step, done: s.done, startedAt: s.startedAt ?? null, doneAt: s.doneAt ?? null, pass: s.pass ?? 1 })),
      },
      timelineLines,
      Date.now(),
    ));
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
      case "d":
        if (t?.kind === "repo") void openDetail(t);
        else if (t?.kind === "run") void openWorkItemDetail(t);
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
