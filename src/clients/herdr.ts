import { run, runJson } from "./exec.ts";
import { HerdrUnreachableError, type LivenessOpts } from "../core/deps.ts";
import type { Agent, FocusedPane, WorktreeResult } from "../types.ts";

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

  /** Start a claude agent; argv[0] is the executable (e.g. "claude"). Echoes its pane id. */
  async agentStart(opts: {
    workspaceId: string;
    cwd: string;
    argv: string[];
    env?: Record<string, string>;
  }): Promise<string | null> {
    const args = ["agent", "start", "claude", "--workspace", opts.workspaceId, "--cwd", opts.cwd, "--no-focus"];
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
