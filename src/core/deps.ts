import type { AgentCfg, Config, Secrets, SourceType } from "../config.ts";
import type { Store } from "../db/store.ts";
import type { Agent, FocusedPane, PrInfo, ReviewSig, Ticket, WorkState, WorktreeResult } from "../types.ts";

// Interfaces the core depends on (concrete clients satisfy them structurally;
// tests provide fakes). Keeping these here is what makes the reconciler testable.

export interface HerdrApi {
  worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult>;
  worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult>;
  worktreeRemove(workspaceId: string): Promise<void>;
  workspaceClose(workspaceId: string): Promise<void>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  paneState(paneId: string): Promise<string>;
  paneAlive(paneId: string): Promise<boolean>;
  agentSessionId(paneId: string): Promise<string | null>;
  tabPaneByLabel(workspaceId: string, tabLabel: string, paneLabel: string): Promise<string | null>;
  agentStart(opts: { workspaceId: string; cwd: string; argv: string[]; env?: Record<string, string> }): Promise<string | null>;
  paneRun(paneId: string, command: string): Promise<void>;
  agentSend(paneId: string, text: string): Promise<void>;
  agentFocus(paneId: string): Promise<void>;
  focusedPane(): Promise<FocusedPane | null>;
  paneSendKeys(paneId: string, ...keys: string[]): Promise<void>;
  agentRename(paneId: string, name: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

/**
 * A polymorphic source of work (Jira board, folder of markdown, …). The reconciler speaks only
 * this interface and the canonical WorkState lifecycle — each implementation maps onto its own
 * backend. Construction (and any backend config / Store handle) lives in the concrete clients.
 */
export interface WorkSource {
  /** Eligible (todo) items in the order they should be claimed. Must NOT throw on a transient
   *  backend hiccup beyond what the caller try/catches per source; returns [] when there's none. */
  listEligible(): Promise<Ticket[]>;
  /** Metadata for one item by key (for the manual `claim` path). Throws if the item is unknown. */
  describe(key: string): Promise<Ticket>;
  /** Move an item to a canonical lifecycle state. Returns false (no-op) if already there or the
   *  state is unmapped for this source. MUST NOT touch the network for an unmapped state. */
  transition(key: string, to: WorkState): Promise<boolean>;
  /** Write the item's work doc (+ any media) into `memDir` for the fix agent. Idempotent (a
   *  no-op once already materialized). Best-effort: logs rather than throwing on backend issues. */
  materialize(key: string, memDir: string, log: Logger): Promise<void>;
  /** Throw if the source is misconfigured/unreachable (the `doctor` per-source check). */
  health(): Promise<void>;
}

/** A configured source's identity + per-source layout/agents + its live client. Resolved once
 *  per run from `run.workSource` and threaded through the reconciler. */
export interface SourceRuntime {
  name: string;
  type: SourceType;
  priority: number;
  workspaceName?: string;
  agents: { fix: AgentCfg; review: AgentCfg; pr: AgentCfg };
  client: WorkSource;
}

export interface GitHubApi {
  prForBranch(repo: string, branch: string): Promise<PrInfo | null>;
  reviewSignature(repo: string, prNumber: number): Promise<ReviewSig>;
}

export interface GitApi {
  branchExists(repoCwd: string, branch: string): Promise<boolean>;
  branchDelete(repoCwd: string, branch: string): Promise<void>;
  worktreePrune(repoCwd: string): Promise<void>;
  originUrl(repoCwd: string): Promise<string>;
  headSha(repoCwd: string): Promise<string | null>;
}

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;

export interface Deps {
  config: Config;
  secrets: Secrets;
  store: Store;
  ghRepo: string; // resolved owner/name
  herdr: HerdrApi;
  sources: SourceRuntime[]; // configured work sources, ordered by priority (asc)
  resolveSource(name: string | null): SourceRuntime | undefined; // by run.workSource; total
  github: GitHubApi;
  git: GitApi;
  log: Logger;
  now: () => number; // epoch seconds
  sleep: (ms: number) => Promise<void>;
  rmrf: (path: string) => Promise<void>; // recursive force delete (teardown's defensive dir cleanup)
}

export type { Agent };
