// Shared domain types.

export type Phase =
  | "claiming"
  | "developing"
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
    | "attentionReason"
    | "outcome"
  >
>;

/** epoch-seconds clock, injected for testability. */
export type Clock = () => number;
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);
