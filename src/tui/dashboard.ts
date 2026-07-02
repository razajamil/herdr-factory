// Dashboard tab — read-only, per-repo view of what the factory is doing. Repos come from disk
// (listConfiguredRepos); live status comes from the resident server (api.ts). When the server is
// down we still list the repos with a hint on how to start it. Auto-refreshes every 3s while the
// tab is active.
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { Renderable } from "@opentui/core";
import { listConfiguredRepos } from "../config.ts";
import { fetchHealth, fetchStatus, type ActiveRun, type RepoStatus } from "./api.ts";
import { BORDER, theme } from "./theme.ts";
import type { TabView } from "./types.ts";

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
  if (/attention|stall|wait/.test(p)) return theme.status.warn;
  if (/review|pr|ci|merg/.test(p)) return theme.accent;
  return theme.text.primary;
}

export function createDashboard(renderer: CliRenderer): TabView {
  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: theme.bg,
    paddingLeft: 1,
    paddingRight: 1,
  });
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
    title: " 1 · repos ",
    titleColor: theme.text.secondary,
    paddingLeft: 1,
    paddingRight: 1,
  });
  root.add(banner);
  root.add(list);

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  function clearList(): void {
    for (const c of [...list.getChildren()]) {
      list.remove(c.id);
      c.destroy();
    }
  }

  function line(content: string, fg: string): TextRenderable {
    return new TextRenderable(renderer, { content, fg, width: "100%", height: 1, wrapMode: "none" });
  }

  function repoCard(name: string, st: RepoStatus | null): Renderable {
    const card = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      backgroundColor: theme.bg,
      border: true,
      borderStyle: BORDER,
      borderColor: theme.border.inactive,
      marginBottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
      title: ` ${name} `,
      titleColor: theme.accent,
    });
    if (!st) {
      card.add(line("  (status unavailable)", theme.text.tertiary));
      return card;
    }
    const sources = st.sources.map((s) => s.name).join(", ") || "—";
    const belts = st.belts.map((b) => b.name).join(", ") || "—";
    card.add(line(`active ${st.active.length}/${st.limits.maxActive}   sources: ${sources}   belts: ${belts}`, theme.text.secondary));
    if (st.active.length === 0) {
      card.add(line("  idle — no active runs", theme.text.tertiary));
    } else {
      for (const run of st.active) {
        const step = run.step ? `/${run.step}` : "";
        const pr = run.prNumber ? `  PR #${run.prNumber}` : "";
        const summary = run.summary ? `  ${run.summary}` : "";
        card.add(line(`  ${run.ticketKey}  ${run.phase}${step}${pr}${summary}`, runColor(run)));
      }
    }
    return card;
  }

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const health = await fetchHealth();
      if (timer === null) return; // deactivated mid-flight
      const repos = listConfiguredRepos();
      clearList();
      if (!health) {
        banner.content = "⚠ server not running — start it with `herdr-factory serve`";
        banner.fg = theme.status.warn;
        if (repos.length === 0) list.add(line("  no repos configured under ~/.config/herdr-factory/repos", theme.text.tertiary));
        for (const name of repos) list.add(repoCard(name, null));
        return;
      }
      banner.content = `● server up · v${health.version} · uptime ${fmtDuration(health.uptimeSec)}`;
      banner.fg = theme.status.good;
      for (const name of repos) {
        const st = await fetchStatus(name);
        if (timer === null) return;
        list.add(repoCard(name, st));
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    root,
    sectionCount: 1,
    focusSection(n: number) {
      if (n === 1) list.focus();
    },
    restoreFocus() {
      list.focus(); // one section
    },
    activate() {
      // Set the timer before the first refresh so refresh()'s `timer === null` deactivation guard
      // doesn't bail on the initial paint.
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
