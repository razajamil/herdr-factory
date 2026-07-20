import { basename } from "node:path";
import { run, runJson } from "./exec.ts";
import { HerdrUnreachableError, type LivenessOpts } from "../core/deps.ts";
import type { Agent, FocusedPane, WorkspaceInfo, WorktreeResult } from "../types.ts";

/** The herdr agent KIND (`herdr agent start <name>`) for a spawn argv. herdr uses it to pick the
 *  integration that detects idle/working for the pane, so it must name the real harness — we derive
 *  it from the executable (argv[0]'s basename), which is the configured `agent.command`. A full path
 *  (`/opt/homebrew/bin/claude`) still yields `claude`; an empty/absent argv falls back to `claude`.
 *  Byte-identical to the old hardcoded "claude" whenever argv[0] is `claude`. */
export function agentKindForArgv(argv: readonly string[]): string {
  return (argv[0] ? basename(argv[0]) : "") || "claude";
}

interface RawAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: string;
  cwd: string;
  agent_session?: { value?: string };
}
interface AgentListResp {
  result?: { agents?: RawAgent[] };
}
interface WorktreeResp {
  result?: {
    workspace?: { workspace_id?: string; worktree?: { checkout_path?: string } };
    root_pane?: { pane_id?: string; workspace_id?: string; cwd?: string };
  };
}
interface TabListResp {
  result?: { tabs?: { tab_id: string; label?: string }[] };
}
interface PaneListResp {
  result?: { panes?: { pane_id: string; workspace_id: string; tab_id: string; label?: string; focused?: boolean }[] };
}
interface AgentStartResp {
  result?: { agent?: { pane_id?: string } };
}
interface TabCreateResp {
  result?: { tab?: { tab_id?: string }; tab_id?: string; root_pane?: { pane_id?: string }; pane?: { pane_id?: string }; pane_id?: string };
}
interface PaneSplitResp {
  result?: { pane?: { pane_id?: string }; pane_id?: string };
}
interface PaneLayoutResp {
  result?: { layout?: { panes?: { pane_id?: string; rect?: { width?: number; height?: number } }[] } };
}
interface WaitOutputResp {
  result?: { matched_line?: string };
}
interface RawWorkspace {
  workspace_id?: string;
  active_tab_id?: string;
  tab_count?: number;
  pane_count?: number;
  worktree?: { checkout_path?: string; repo_root?: string; repo_name?: string; is_linked_worktree?: boolean };
}
interface WorkspaceGetResp {
  result?: { workspace?: RawWorkspace };
}
interface WorkspaceListResp {
  result?: { workspaces?: RawWorkspace[] };
}
interface WorktreeListResp {
  result?: { worktrees?: { path?: string; branch?: string; open_workspace_id?: string }[] };
}

/**
 * Thin typed wrapper over the `herdr` CLI. herdr owns the worktree / workspace /
 * tab / pane / agent lifecycle — this class only shells out and parses; it
 * reimplements none of it.
 */
export class HerdrClient {
  private readonly bin: string;
  constructor(bin: string = "herdr") {
    this.bin = bin;
  }

  private parseWorktree(j: WorktreeResp): WorktreeResult {
    const workspaceId = j.result?.workspace?.workspace_id ?? j.result?.root_pane?.workspace_id;
    const worktreePath = j.result?.workspace?.worktree?.checkout_path ?? j.result?.root_pane?.cwd;
    const paneId = j.result?.root_pane?.pane_id ?? null;
    if (!workspaceId || !worktreePath) {
      throw new Error(`herdr worktree result missing workspace/path: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return { workspaceId, worktreePath, paneId };
  }

  // Worktree ops run real git checkouts (can be slow on big repos) — give them a bigger budget
  // than the default exec timeout, but still a HARD one (a hung herdr must not wedge the tick).
  private static readonly WORKTREE_TIMEOUT_MS = 180_000;

  async worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult> {
    return this.parseWorktree(
      await runJson<WorktreeResp>(this.bin, [
        "worktree", "create", "--cwd", repoCwd, "--branch", branch, "--base", baseRef, "--no-focus", "--json",
      ], { timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS }),
    );
  }

  async worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult> {
    return this.parseWorktree(
      await runJson<WorktreeResp>(this.bin, ["worktree", "open", "--cwd", repoCwd, "--branch", branch, "--no-focus", "--json"], {
        timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS,
      }),
    );
  }

  /** Removes the workspace, checkout dir, and git worktree registration (herdr-owned). */
  async worktreeRemove(workspaceId: string): Promise<void> {
    await run(this.bin, ["worktree", "remove", "--workspace", workspaceId, "--force", "--json"], {
      allowFail: true,
      timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS,
    });
  }

  /** Close the workspace + its panes (independent of git-worktree state). The fallback when
   *  `worktree remove` deregisters the git worktree but then fails to close the workspace. */
  async workspaceClose(workspaceId: string): Promise<void> {
    await run(this.bin, ["workspace", "close", workspaceId], { allowFail: true });
  }

  async workspaceExists(workspaceId: string): Promise<boolean> {
    const r = await run(this.bin, ["workspace", "get", workspaceId], { allowFail: true });
    return r.code === 0;
  }

  // One `herdr agent list` answers every liveness question for ~all runs in a tick, so the
  // result is memoized briefly — at 50-100 active runs this collapses O(runs) subprocess spawns
  // per tick into ~one, and it's what makes the fresh-read confirmation below meaningful.
  private static readonly AGENTS_MEMO_MS = 5_000;
  private agentsMemo: { at: number; agents: Agent[] } | null = null;

  /** Agents herdr currently tracks. THROWS HerdrUnreachableError when herdr can't be queried —
   *  an empty list is a real "no agents", never a masked failure (that masking is exactly what
   *  used to make a herdr hiccup look like mass pane death). */
  async agents(opts: LivenessOpts = {}): Promise<Agent[]> {
    if (!opts.fresh && this.agentsMemo && Date.now() - this.agentsMemo.at < HerdrClient.AGENTS_MEMO_MS) {
      return this.agentsMemo.agents;
    }
    let j: AgentListResp;
    try {
      j = await runJson<AgentListResp>(this.bin, ["agent", "list"]);
    } catch (e) {
      this.agentsMemo = null;
      throw new HerdrUnreachableError(e);
    }
    const agents = (j.result?.agents ?? []).map((a) => ({
      paneId: a.pane_id,
      workspaceId: a.workspace_id,
      tabId: a.tab_id,
      agent: a.agent,
      agentStatus: a.agent_status,
      cwd: a.cwd,
      sessionId: a.agent_session?.value ?? null,
    }));
    this.agentsMemo = { at: Date.now(), agents };
    return agents;
  }

  async paneState(paneId: string, opts: LivenessOpts = {}): Promise<string> {
    const a = (await this.agents(opts)).find((x) => x.paneId === paneId);
    return a?.agentStatus ?? "gone";
  }

  /** The claude session id herdr tracks for a pane (on-demand cross-agent query handle). */
  async agentSessionId(paneId: string): Promise<string | null> {
    return (await this.agents()).find((x) => x.paneId === paneId)?.sessionId ?? null;
  }

  async paneAlive(paneId: string, opts: LivenessOpts = {}): Promise<boolean> {
    return (await this.agents(opts)).some((x) => x.paneId === paneId);
  }

  /** Resolve the pane with `paneLabel` inside the tab labelled `tabLabel` (or null). */
  async tabPaneByLabel(workspaceId: string, tabLabel: string, paneLabel: string): Promise<string | null> {
    const tabs = await runJson<TabListResp>(this.bin, ["tab", "list", "--workspace", workspaceId], {
      allowFail: true,
    }).catch(() => ({}) as TabListResp);
    const tab = (tabs.result?.tabs ?? []).find((t) => t.label === tabLabel);
    if (!tab) return null;
    const panes = await runJson<PaneListResp>(this.bin, ["pane", "list", "--workspace", workspaceId], {
      allowFail: true,
    }).catch(() => ({}) as PaneListResp);
    const pane = (panes.result?.panes ?? []).find((p) => p.tab_id === tab.tab_id && p.label === paneLabel);
    return pane?.pane_id ?? null;
  }

  /** Start an agent; argv[0] is the executable (e.g. "claude", "opencode"). The herdr agent kind
   *  is derived from argv[0] (agentKindForArgv) so a configured non-claude harness is detected
   *  correctly. Echoes its pane id. */
  async agentStart(opts: {
    workspaceId: string;
    cwd: string;
    argv: string[];
    env?: Record<string, string>;
  }): Promise<string | null> {
    const args = ["agent", "start", agentKindForArgv(opts.argv), "--workspace", opts.workspaceId, "--cwd", opts.cwd, "--no-focus"];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
    args.push("--", ...opts.argv);
    const j = await runJson<AgentStartResp>(this.bin, args, { allowFail: true }).catch(
      () => ({}) as AgentStartResp,
    );
    this.agentsMemo = null; // the agent set just changed — don't serve a pre-spawn snapshot
    return j.result?.agent?.pane_id ?? null;
  }

  async paneRun(paneId: string, command: string): Promise<void> {
    await run(this.bin, ["pane", "run", paneId, command], { allowFail: true });
  }

  // ── Layout building (absorbed from the workspace-manager plugin). argv mirrors that plugin's
  //    runner exactly; see src/core/layout.ts for the planner that drives these. ──

  /** Create a new tab in the workspace (opening in `cwd` if given); returns the tab + its root pane. */
  async tabCreate(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<{ tabId: string; paneId: string }> {
    const args = ["tab", "create", "--workspace", workspaceId, "--no-focus"];
    if (opts.label) args.push("--label", opts.label);
    if (opts.cwd) args.push("--cwd", opts.cwd);
    const j = await runJson<TabCreateResp>(this.bin, args, { timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS });
    const tabId = j.result?.tab?.tab_id ?? j.result?.tab_id;
    const paneId = j.result?.root_pane?.pane_id ?? j.result?.pane?.pane_id ?? j.result?.pane_id;
    if (!tabId || !paneId) throw new Error(`herdr tab create missing ids: ${JSON.stringify(j).slice(0, 300)}`);
    return { tabId, paneId };
  }

  async tabRename(tabId: string, label: string): Promise<void> {
    await run(this.bin, ["tab", "rename", tabId, label], { allowFail: true });
  }

  /** Split `fromPaneId` (direction right|down; `ratio` is the fraction the FROM pane keeps); returns
   *  the new pane's id. */
  async paneSplit(fromPaneId: string, opts: { direction: "right" | "down"; ratio?: number; cwd?: string }): Promise<string> {
    const args = ["pane", "split", fromPaneId, "--direction", opts.direction, "--no-focus"];
    if (opts.ratio != null) args.push("--ratio", String(Math.round(opts.ratio * 1e4) / 1e4));
    if (opts.cwd) args.push("--cwd", opts.cwd);
    const j = await runJson<PaneSplitResp>(this.bin, args, { timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS });
    const paneId = j.result?.pane?.pane_id ?? j.result?.pane_id;
    if (!paneId) throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(j).slice(0, 300)}`);
    return paneId;
  }

  async paneRename(paneId: string, label: string): Promise<void> {
    await run(this.bin, ["pane", "rename", paneId, label], { allowFail: true });
  }

  /** The pane's current extent in cells along the split axis (width for "right", height for "down"),
   *  or null when it can't be read. Converts a fixed cell `size` into a split ratio. */
  async paneExtent(paneId: string, direction: "right" | "down"): Promise<number | null> {
    const j = await runJson<PaneLayoutResp>(this.bin, ["pane", "layout", "--pane", paneId], { allowFail: true }).catch(
      () => ({}) as PaneLayoutResp,
    );
    const rect = (j.result?.layout?.panes ?? []).find((p) => p.pane_id === paneId)?.rect;
    const side = direction === "down" ? rect?.height : rect?.width;
    return typeof side === "number" && Number.isFinite(side) ? side : null;
  }

  /** Wait for `marker` in the pane's output, up to `timeoutMs` (blocking layout setup). Returns the
   *  matched line, or null on timeout / no match. The exec budget outlasts herdr's own --timeout. */
  async waitOutput(paneId: string, marker: string, timeoutMs: number): Promise<string | null> {
    const j = await runJson<WaitOutputResp>(
      this.bin,
      ["wait", "output", paneId, "--match", marker, "--timeout", String(timeoutMs)],
      { allowFail: true, timeoutMs: timeoutMs + 30_000 },
    ).catch(() => ({}) as WaitOutputResp);
    return j.result?.matched_line ?? null;
  }

  /** The workspace's first (root) tab id — the tab a fresh worktree comes up with. */
  async firstTabId(workspaceId: string): Promise<string | null> {
    const j = await runJson<TabListResp>(this.bin, ["tab", "list", "--workspace", workspaceId], { allowFail: true }).catch(
      () => ({}) as TabListResp,
    );
    return j.result?.tabs?.[0]?.tab_id ?? null;
  }

  // ── Worktree/workspace introspection for the layout event hook (src/core/layout-hook.ts). ──

  private static parseWorkspaceInfo(w: RawWorkspace | undefined): WorkspaceInfo | null {
    if (!w) return null;
    const wt = w.worktree ?? {};
    return {
      checkoutPath: wt.checkout_path ?? null,
      repoRoot: wt.repo_root ?? null,
      repoName: wt.repo_name ?? null,
      isLinkedWorktree: wt.is_linked_worktree === true,
      tabCount: typeof w.tab_count === "number" ? w.tab_count : null,
      paneCount: typeof w.pane_count === "number" ? w.pane_count : null,
      activeTabId: w.active_tab_id ?? null,
    };
  }

  /** A workspace's worktree facts + freshness (tab/pane counts) by id. Tries `workspace get`, then
   *  falls back to scanning `workspace list`. null when the id isn't a known workspace. */
  async workspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null> {
    const got = await runJson<WorkspaceGetResp>(this.bin, ["workspace", "get", workspaceId], { allowFail: true }).catch(
      () => ({}) as WorkspaceGetResp,
    );
    if (got.result?.workspace) return HerdrClient.parseWorkspaceInfo(got.result.workspace);
    const list = await runJson<WorkspaceListResp>(this.bin, ["workspace", "list"], { allowFail: true }).catch(
      () => ({}) as WorkspaceListResp,
    );
    const found = (list.result?.workspaces ?? []).find((w) => w.workspace_id === workspaceId);
    return found ? HerdrClient.parseWorkspaceInfo(found) : null;
  }

  /** The git branch of a workspace's worktree (or null for a detached HEAD / unresolvable). Matches
   *  on the open workspace id, falling back to the checkout path. */
  async worktreeBranch(workspaceId: string, checkoutPath?: string | null): Promise<string | null> {
    const j = await runJson<WorktreeListResp>(this.bin, ["worktree", "list", "--workspace", workspaceId, "--json"], {
      allowFail: true,
    }).catch(() => ({}) as WorktreeListResp);
    const worktrees = j.result?.worktrees ?? [];
    const byWorkspace = worktrees.find((w) => w.open_workspace_id === workspaceId);
    const byPath = checkoutPath ? worktrees.find((w) => w.path === checkoutPath) : undefined;
    const branch = (byWorkspace ?? byPath)?.branch;
    return branch && branch.length > 0 ? branch : null;
  }

  /** The first pane in a tab (a fresh worktree's root pane), or null. */
  async firstPaneOfTab(workspaceId: string, tabId: string): Promise<string | null> {
    const j = await runJson<PaneListResp>(this.bin, ["pane", "list", "--workspace", workspaceId], { allowFail: true }).catch(
      () => ({}) as PaneListResp,
    );
    return (j.result?.panes ?? []).find((p) => p.tab_id === tabId)?.pane_id ?? null;
  }

  async agentSend(paneId: string, text: string): Promise<void> {
    await run(this.bin, ["agent", "send", paneId, text], { allowFail: true });
  }

  /** Focus the agent's pane (and its tab) so a worktree view follows the active step. */
  async agentFocus(paneId: string): Promise<void> {
    await run(this.bin, ["agent", "focus", paneId], { allowFail: true });
  }

  /** The one globally-focused pane (what the user is looking at), or null if none/herdr is
   *  not frontmost. herdr has no focus-change event, so the dispatcher polls this each tick. */
  async focusedPane(): Promise<FocusedPane | null> {
    const j = await runJson<PaneListResp>(this.bin, ["pane", "list"], { allowFail: true }).catch(
      () => ({}) as PaneListResp,
    );
    const p = (j.result?.panes ?? []).find((x) => x.focused);
    return p ? { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, label: p.label ?? null } : null;
  }

  async paneSendKeys(paneId: string, ...keys: string[]): Promise<void> {
    await run(this.bin, ["pane", "send-keys", paneId, ...keys], { allowFail: true });
  }

  async agentRename(paneId: string, name: string): Promise<void> {
    await run(this.bin, ["agent", "rename", paneId, name], { allowFail: true });
  }

  async notify(title: string, body: string): Promise<void> {
    await run(this.bin, ["notification", "show", title, "--body", body, "--sound", "request"], { allowFail: true });
  }
}
