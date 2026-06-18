import { run, runJson } from "./exec.ts";
import type { Agent, WorktreeResult } from "../types.ts";

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
  result?: { panes?: { pane_id: string; tab_id: string; label?: string }[] };
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
  constructor(private readonly bin: string = "herdr") {}

  private parseWorktree(j: WorktreeResp): WorktreeResult {
    const workspaceId = j.result?.workspace?.workspace_id ?? j.result?.root_pane?.workspace_id;
    const worktreePath = j.result?.workspace?.worktree?.checkout_path ?? j.result?.root_pane?.cwd;
    const paneId = j.result?.root_pane?.pane_id ?? null;
    if (!workspaceId || !worktreePath) {
      throw new Error(`herdr worktree result missing workspace/path: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return { workspaceId, worktreePath, paneId };
  }

  async worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult> {
    return this.parseWorktree(
      await runJson<WorktreeResp>(this.bin, [
        "worktree", "create", "--cwd", repoCwd, "--branch", branch, "--base", baseRef, "--no-focus", "--json",
      ]),
    );
  }

  async worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult> {
    return this.parseWorktree(
      await runJson<WorktreeResp>(this.bin, ["worktree", "open", "--cwd", repoCwd, "--branch", branch, "--no-focus", "--json"]),
    );
  }

  /** Removes the workspace, checkout dir, and git worktree registration (herdr-owned). */
  async worktreeRemove(workspaceId: string): Promise<void> {
    await run(this.bin, ["worktree", "remove", "--workspace", workspaceId, "--force", "--json"], { allowFail: true });
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

  async agents(): Promise<Agent[]> {
    const j = await runJson<AgentListResp>(this.bin, ["agent", "list"], { allowFail: true }).catch(
      () => ({}) as AgentListResp,
    );
    return (j.result?.agents ?? []).map((a) => ({
      paneId: a.pane_id,
      workspaceId: a.workspace_id,
      tabId: a.tab_id,
      agent: a.agent,
      agentStatus: a.agent_status,
      cwd: a.cwd,
      sessionId: a.agent_session?.value ?? null,
    }));
  }

  async paneState(paneId: string): Promise<string> {
    const a = (await this.agents()).find((x) => x.paneId === paneId);
    return a?.agentStatus ?? "gone";
  }

  /** The claude session id herdr tracks for a pane (on-demand cross-agent query handle). */
  async agentSessionId(paneId: string): Promise<string | null> {
    return (await this.agents()).find((x) => x.paneId === paneId)?.sessionId ?? null;
  }

  async paneAlive(paneId: string): Promise<boolean> {
    return (await this.agents()).some((x) => x.paneId === paneId);
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
    return j.result?.agent?.pane_id ?? null;
  }

  async paneRun(paneId: string, command: string): Promise<void> {
    await run(this.bin, ["pane", "run", paneId, command], { allowFail: true });
  }

  async agentSend(paneId: string, text: string): Promise<void> {
    await run(this.bin, ["agent", "send", paneId, text], { allowFail: true });
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
