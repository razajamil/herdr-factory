// Shared domain types.

export type Phase =
  | "claiming"
  | "fixing" // fix agent
  | "auto_review" // review agent
  | "pr_round" // pr agent: opens the PR + drives the CI/bot round
  | "reviewing" // human-review watch + resolver
  | "tearing_down"
  | "done"
  | "attention";

/** The pipeline step a phase runs. */
export type StepName = "fix" | "review" | "pr";

export type Outcome = "merged" | "closed" | "abandoned" | "timeout";

/**
 * The canonical work lifecycle, source-agnostic. Each work source maps these onto its own
 * backend: Jira maps todo/in_development/in_review onto configured Jira statuses (merged/aborted
 * are deliberately UNMAPPED — Jira's terminal state is owned by its GitHub integration, so a
 * transition to them is a no-op with no network call); local_markdown maps all five onto rows
 * in the `work_items` table (todo → in_development → in_review → merged|aborted, both terminal).
 */
export type WorkState = "todo" | "in_development" | "in_review" | "merged" | "aborted";

/** Map a run Outcome to the terminal WorkState written back at teardown. */
export function outcomeToWorkState(outcome: Outcome): "merged" | "aborted" {
  // merged is the only success; everything else (PR closed, abandoned, watch timeout) is aborted.
  switch (outcome) {
    case "merged":
      return "merged";
    case "closed":
    case "abandoned":
    case "timeout":
      return "aborted";
  }
}

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
  | "step_spawned"
  | "step_done"
  | "focus_applied"
  | "merged"
  | "closed"
  | "torn_down"
  | "attention"
  | "error";

/** A single attempt at delivering one Jira ticket as a PR. */
export interface Run {
  id: number;
  repo: string;
  workSource: string | null; // which configured work source this run was claimed from
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
  attentionReason: string | null;
  outcome: Outcome | null;
  focusPending: boolean; // active step changed; focus shift deferred until the user views this worktree
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
    | "attentionReason"
    | "outcome"
    | "focusPending"
  >
>;

/** One agent step of a run's pipeline (fix/review/pr), each in its own herdr pane. */
export interface RunStep {
  id: number;
  runId: number;
  step: StepName;
  paneId: string | null;
  sessionId: string | null; // the agent's claude session id (on-demand query handle)
  progressSig: string | null; // last-seen branch HEAD (per-step heartbeat)
  progressAt: number | null;
  done: boolean;
  startedAt: number | null;
  doneAt: number | null;
}

/** Fields the reconciler may patch on a run step. */
export type RunStepPatch = Partial<
  Pick<RunStep, "paneId" | "sessionId" | "progressSig" | "progressAt" | "done" | "startedAt">
>;

/** A local_markdown work item's internally-tracked lifecycle row (the `work_items` table).
 *  This is herdr-factory's own status ledger for sources that have no external status of record. */
export interface WorkItem {
  id: number;
  repo: string;
  source: string;
  key: string;
  title: string | null;
  itemType: string | null;
  path: string | null;
  status: WorkState;
  createdAt: number;
  updatedAt: number;
}

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
    comment?: unknown; // { comments: [{ author, created, body (ADF), … }], … }
  };
}

export interface WorktreeResult {
  workspaceId: string;
  worktreePath: string;
  paneId: string | null;
}

/** The single globally-focused pane (what the user is looking at right now). */
export interface FocusedPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  label: string | null;
}

export interface Agent {
  paneId: string;
  workspaceId: string;
  tabId: string;
  agent: string;
  agentStatus: string; // idle | working | done | blocked | unknown
  cwd: string;
  sessionId: string | null; // herdr agent_session.value (the claude session id)
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
