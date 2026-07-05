// Shared domain types.

/**
 * A run's lifecycle position — belt-agnostic now. `running` means a belt step's agent is active
 * (which step is on `run.step`); the old per-step phases (fixing/auto_review/pr_round) collapsed
 * into it once steps became belt-defined. `reviewing` (the token-free PR watch + resolver) is
 * entered only by `work_to_pull_request` belts after their PR step; `custom` belts never reach it.
 */
export type Phase =
  | "claiming"
  | "running" // a belt step's agent is active (run.step says which)
  | "waiting_for_human" // a belt step is parked until its source returns human guidance
  | "reviewing" // work_to_pull_request only: human-review watch + resolver
  | "tearing_down"
  | "done"
  | "attention";

/** A belt step's name. Fixed (fix|review|pr) for work_to_pull_request, user-defined for custom —
 *  so it's just a string; the configured belt is the source of truth for which names are valid. */
export type StepName = string;

// merged|closed come from a PR; completed is a non-PR belt's success (last step signalled done);
// abandoned|timeout are failures.
export type Outcome = "merged" | "closed" | "abandoned" | "timeout" | "completed";

/**
 * The canonical work lifecycle, source-agnostic. Each work source maps these onto its own
 * backend: Jira maps todo/in_development/in_review onto configured Jira statuses (merged/aborted/
 * done are deliberately UNMAPPED — Jira's terminal state is owned by its GitHub integration, so a
 * transition to them is a no-op with no network call); local_markdown maps all of them onto rows
 * in the `work_items` table. `done` is the terminal state for a custom (non-PR) belt's success.
 */
export type WorkState = "todo" | "in_development" | "in_review" | "merged" | "aborted" | "done";

/** Map a run Outcome to the terminal WorkState written back at teardown. */
export function outcomeToWorkState(outcome: Outcome): "merged" | "aborted" | "done" {
  switch (outcome) {
    case "merged":
      return "merged"; // PR merged
    case "completed":
      return "done"; // custom belt finished its last step
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
  | "bounced"
  | "human_question"
  | "human_reply"
  | "focus_applied"
  | "merged"
  | "closed"
  | "torn_down"
  | "attention"
  | "error";

/** A single attempt at running one work item through a belt. */
export interface Run {
  id: number;
  repo: string;
  workSource: string | null; // which configured work source this run was claimed from
  belt: string | null; // which belt is processing it (its step sequence + lifecycle)
  ticketKey: string;
  summary: string | null;
  issueType: string | null;
  branch: string | null;
  phase: Phase;
  step: string | null; // the active belt step when phase === "running"
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
    | "step"
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

/** One agent step of a run's pipeline (fix/evidence/review/pr for work_to_pull_request), each in its
 *  own herdr pane. `bounces` counts how many times a LATER step sent the run back to this step for
 *  rework — the loop-safety counter the reconciler escalates on past `limits.maxBounces`. */
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
  bounces: number; // times a later step bounced work back to this step (loop-safety counter)
  /** When this step's pane was first CONFIRMED absent (herdr answered without it); null = believed
   *  alive. Respawn requires a second confirmed absence past the confirmation window. */
  absentAt: number | null;
}

/** Fields the reconciler may patch on a run step. */
export type RunStepPatch = Partial<
  Pick<RunStep, "paneId" | "sessionId" | "progressSig" | "progressAt" | "done" | "startedAt" | "absentAt">
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

export type HumanQuestionStatus = "pending" | "answered";

/** A source-agnostic human-in-the-loop question parked by an agent and resumed by the reconciler. */
export interface HumanQuestion {
  id: number;
  runId: number;
  repo: string;
  workSource: string;
  ticketKey: string;
  step: string | null;
  question: string;
  status: HumanQuestionStatus;
  externalId: string | null;
  externalCreatedAt: string | null;
  answer: string | null;
  answerExternalId: string | null;
  answerAuthor: string | null;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
}

export type HumanQuestionPatch = Partial<
  Pick<HumanQuestion, "status" | "externalId" | "externalCreatedAt" | "answer" | "answerExternalId" | "answerAuthor" | "answeredAt">
>;

export interface HumanAskInput {
  repo: string;
  runId: number;
  questionId: number;
  key: string;
  step: string | null;
  question: string;
}

export interface HumanAskResult {
  externalId: string;
  externalCreatedAt?: string | null;
}

export interface HumanPollInput {
  key: string;
  questionId: number;
  externalId: string;
  externalCreatedAt?: string | null;
}

export interface HumanReply {
  body: string;
  externalId: string;
  externalCreatedAt?: string | null;
  author?: string | null;
}

/** The kind of backend a work source polls. */
export type SourceType = "jira" | "local_markdown";

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

// --- belt routing (the `match` predicate) -----------------------------------
// A belt may carry a `match` predicate (a `.ts` module's default export). At claim time the
// reconciler walks belts in priority order and the FIRST belt whose predicate returns true claims
// the item (a belt with no predicate accepts anything from its source). The predicate receives the
// item's metadata + its source — enough to route on without claiming first. These types are
// exported so a user's `match.ts` can import them: `import type { BeltMatch } from ".../types.ts"`.

/** The source a candidate item came from. */
export interface MatchSource {
  name: string;
  type: SourceType;
}

/** A Jira candidate (sourceType "jira") exposed to a belt's match predicate. `fields` is the raw
 *  Jira issue.fields object (summary/status/issuetype/labels/…) for arbitrary routing. */
export interface JiraMatchItem {
  sourceType: "jira";
  key: string;
  summary: string;
  type: string; // issue type name, e.g. "Bug"
  status: string; // current Jira status name
  labels: string[];
  fields: Record<string, unknown>;
}

/** A local_markdown candidate (sourceType "local_markdown") exposed to a belt's match predicate. */
export interface LocalMarkdownMatchItem {
  sourceType: "local_markdown";
  key: string;
  summary: string;
  type: string;
  path: string; // the .md file or directory backing this item
  filename: string; // basename of `path`
  frontMatter: Record<string, unknown>; // parsed YAML front-matter ({} when none)
  body: string; // the markdown body (front-matter stripped)
}

/** A candidate work item: the rich, source-tagged metadata a source surfaces from `listEligible`.
 *  Belts route on it (as `ctx.item`), and the lean Ticket (key/summary/type) used for claim +
 *  branch naming is derived from it via `ticketOf` — so key/summary/type live in exactly one place. */
export type MatchItem = JiraMatchItem | LocalMarkdownMatchItem;

export interface MatchContext {
  item: MatchItem;
  source: MatchSource;
}

/** The shape of a belt's `match.ts` default export. May be sync or async. */
export type BeltMatch = (ctx: MatchContext) => boolean | Promise<boolean>;

/** The lean Ticket every candidate carries (key/summary/type) — for claim + branch naming. */
export function ticketOf(item: MatchItem): Ticket {
  return { key: item.key, summary: item.summary, type: item.type };
}
