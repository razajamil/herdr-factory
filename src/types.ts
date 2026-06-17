// Shared domain types.

export type Phase =
  | "claiming"
  | "developing"
  | "auto_review"
  | "reviewing"
  | "tearing_down"
  | "done"
  | "attention";

export type Outcome = "merged" | "closed" | "abandoned" | "timeout";

export type EventType =
  | "claimed"
  | "transition"
  | "worktree_created"
  | "worker_spawned"
  | "pr_opened"
  | "resolver_woken"
  | "worker_done"
  | "review_spawned"
  | "review_done"
  | "merged"
  | "closed"
  | "torn_down"
  | "attention"
  | "error";

/** A single attempt at delivering one Jira ticket as a PR. */
export interface Run {
  id: number;
  repo: string;
  ticketKey: string;
  summary: string | null;
  issueType: string | null;
  branch: string | null;
  phase: Phase;
  workspaceId: string | null;
  paneId: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  watchDeadline: number | null; // epoch seconds
  lastThreadSig: string | null;
  workerDone: boolean;
  reviewDone: boolean;
  reviewPane: string | null;
  progressSig: string | null; // last-seen branch HEAD (worker progress heartbeat)
  progressAt: number | null; // epoch seconds the heartbeat last advanced
  attentionReason: string | null;
  outcome: Outcome | null;
  createdAt: number; // epoch seconds
  updatedAt: number;
  endedAt: number | null;
}

/** Fields the reconciler may patch on a run. */
export type RunPatch = Partial<
  Pick<
    Run,
    | "phase"
    | "branch"
    | "summary"
    | "issueType"
    | "workspaceId"
    | "paneId"
    | "worktreePath"
    | "prNumber"
    | "watchDeadline"
    | "lastThreadSig"
    | "workerDone"
    | "reviewDone"
    | "reviewPane"
    | "progressSig"
    | "progressAt"
    | "attentionReason"
    | "outcome"
  >
>;

/** epoch-seconds clock, injected for testability. */
export type Clock = () => number;
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

// --- client domain types ----------------------------------------------------

export interface Ticket {
  key: string;
  summary: string;
  type: string;
}

export interface JiraAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: string;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    issuetype?: { name: string };
    labels?: string[];
    attachment?: JiraAttachment[];
    description?: unknown;
  };
}

export interface WorktreeResult {
  workspaceId: string;
  worktreePath: string;
  paneId: string | null;
}

export interface Agent {
  paneId: string;
  workspaceId: string;
  tabId: string;
  agent: string;
  agentStatus: string; // idle | working | done | blocked | unknown
  cwd: string;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED";
export interface PrInfo {
  number: number;
  state: PrState;
  url: string;
}

export interface ReviewSig {
  unresolved: number;
  failing: number;
  sig: string;
}
