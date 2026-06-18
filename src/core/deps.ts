import type { Config, Secrets } from "../config.ts";
import type { Store } from "../db/store.ts";
import type { Agent, JiraIssue, PrInfo, ReviewSig, Ticket, WorktreeResult } from "../types.ts";

// Interfaces the core depends on (concrete clients satisfy them structurally;
// tests provide fakes). Keeping these here is what makes the reconciler testable.

export interface HerdrApi {
  worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult>;
  worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult>;
  worktreeRemove(workspaceId: string): Promise<void>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  paneState(paneId: string): Promise<string>;
  paneAlive(paneId: string): Promise<boolean>;
  paneHasClaude(paneId: string): Promise<boolean>;
  agentSessionId(paneId: string): Promise<string | null>;
  tabPaneByLabel(workspaceId: string, tabLabel: string, paneLabel: string): Promise<string | null>;
  agentStart(opts: { workspaceId: string; cwd: string; argv: string[]; env?: Record<string, string> }): Promise<string | null>;
  paneRun(paneId: string, command: string): Promise<void>;
  agentSend(paneId: string, text: string): Promise<void>;
  paneSendKeys(paneId: string, ...keys: string[]): Promise<void>;
  agentRename(paneId: string, name: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

export interface JiraApi {
  listEligible(board: string, label: string, todoStatus: string): Promise<Ticket[]>;
  getIssue(key: string): Promise<JiraIssue>;
  currentStatus(key: string): Promise<string>;
  transition(key: string, targetName: string): Promise<boolean>;
  downloadImages(key: string, outDir: string, max: number, maxBytes: number): Promise<string[]>;
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
  jira: JiraApi;
  github: GitHubApi;
  git: GitApi;
  log: Logger;
  now: () => number; // epoch seconds
  sleep: (ms: number) => Promise<void>;
}

export type { Agent };
