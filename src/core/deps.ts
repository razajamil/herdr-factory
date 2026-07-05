import type { BeltConfig, Config, Secrets } from "../config.ts";
import type { Store } from "../db/store.ts";
import type {
  Agent,
  BeltMatch,
  FocusedPane,
  HumanAskInput,
  HumanAskResult,
  HumanPollInput,
  HumanReply,
  MatchItem,
  PrInfo,
  PrSnapshot,
  ReviewSig,
  SourceType,
  Ticket,
  TransitionResult,
  WorkDocInfo,
  WorkState,
  WorktreeResult,
} from "../types.ts";

// Interfaces the core depends on (concrete clients satisfy them structurally;
// tests provide fakes). Keeping these here is what makes the reconciler testable.

/**
 * herdr could not be queried (CLI failure, timeout, daemon restart). Deliberately DISTINCT from
 * "herdr answered and the pane is absent": conflating the two is what used to make one herdr
 * hiccup look like every pane dying at once — and the recovery action (respawn) would put a
 * duplicate agent into a worktree whose original agent was still working. Liveness callers must
 * treat this as "unknown — defer", never as "dead".
 */
export class HerdrUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`herdr unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HerdrUnreachableError";
  }
}

/** Liveness lookups accept `fresh: true` to bypass the client's short memo — used to CONFIRM an
 *  absence before acting on it (a stale cached list must never trigger a respawn). */
export interface LivenessOpts {
  fresh?: boolean;
}

export interface HerdrApi {
  worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult>;
  worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult>;
  worktreeRemove(workspaceId: string): Promise<void>;
  workspaceClose(workspaceId: string): Promise<void>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  /** THROWS HerdrUnreachableError when herdr can't be queried; "gone" means confirmed absent. */
  paneState(paneId: string, opts?: LivenessOpts): Promise<string>;
  /** THROWS HerdrUnreachableError when herdr can't be queried; false means confirmed absent. */
  paneAlive(paneId: string, opts?: LivenessOpts): Promise<boolean>;
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

/** Declarative ownership/capability record for a work source. Consumed by doctor, the TUI, and
 *  the shared contract test suite ONLY — the reconciler never branches on it, so it cannot drift
 *  into a second state machine. Must be constant for the instance's lifetime. */
export interface WorkSourceSpec {
  /** "external": the backend owns lifecycle (Jira statuses, GitHub labels/open-closed) and the
   *  source MUST NEVER touch the work_items table (db/migrate.ts v6 comment).
   *  "internal": herdr-factory's work_items table owns it (local_markdown). */
  statusOfRecord: "external" | "internal";
  /** The WorkStates transition() actually writes. Everything else must be a network-free noop —
   *  the contract suite asserts it. */
  mappedStates: readonly WorkState[];
  /** How human replies arrive — scopes the contract suite's marker tests (comment-stream sources
   *  must filter their own artifacts; file-channel sources read a dedicated answer section). */
  replyChannel: "comments" | "file";
  /** Note when terminal convergence is (partly) owned by backend automation — display only. */
  terminalAutomation?: string;
}

/** Every artifact a source writes to its reply channel carries this visible prefix, and reply
 *  polling skips artifacts bearing it (INV-6). Shared so all sources mark and filter uniformly. */
export const HERDR_MARKER = "[herdr-factory";

/** INV-6's filter primitive: does this comment body carry the herdr marker OUTSIDE blockquotes?
 *  Quote-reply UIs (GitHub's "Quote reply") prepend the question — marker included — as `> ` lines
 *  into a genuine human reply; a marker appearing only inside quotes must NOT disqualify it. */
export function bearsHerdrMarker(body: string): boolean {
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .some((line) => line.includes(HERDR_MARKER));
}

/**
 * A polymorphic source of work (Jira board, folder of markdown, GitHub issues, …). The reconciler
 * speaks ONLY this interface + the canonical WorkState lifecycle (types.ts) — each implementation
 * maps them onto its own backend. Construction (backend config / Store handle / secrets) lives in
 * the concrete clients.
 *
 * THE CHARTER — numbered invariants every implementation must uphold, enforced by
 * test/work-source-contract.test.ts:
 *
 * INV-1  RE-CLAIM CONVERGENCE: whatever listEligible filters on MUST be moved by a delivered
 *        transition(in_development | terminal). The engine's only other guards — an active run
 *        for (source, key) and a pending write-back — eventually clear, after which a still-listed
 *        item is claimed again and the work re-done.
 * INV-2  transition is IDEMPOTENT and retry-safe: the outbox re-calls it after partial failures,
 *        strictly in-order per run. applied/noop/stale = delivered; throw = retry with 60s→1h
 *        backoff, never abandoned.
 * INV-3  UNMAPPED states cost ZERO network (see TransitionResultKind "noop"). Reads to establish
 *        "already converged" for a MAPPED state are allowed.
 * INV-4  materialize is IDEMPOTENT (no-op once the primary doc exists) and BEST-EFFORT (log,
 *        never throw) — it re-runs on EVERY claiming tick. Sanitize untrusted text for prompt use
 *        (strip HTML comments + invisible chars; keep the raw payload in a sidecar). Never promise
 *        complete media capture.
 * INV-5  askHuman returns a DURABLE externalId (+ createdAt when available); it is re-invoked
 *        every tick until an externalId is persisted, so it SHOULD be idempotent per questionId
 *        (search for the question marker before posting). Throw StaleItemError when the item is
 *        gone.
 * INV-6  SELF-AUTHORSHIP: every artifact the source writes to the reply channel (questions, notes)
 *        MUST carry the visible HERDR_MARKER prefix, and pollHumanReply MUST skip marker-bearing
 *        artifacts (via bearsHerdrMarker — blockquote-aware, so a quote-reply that embeds the
 *        question still counts as a reply). Author-identity filtering is NEVER load-bearing: with
 *        shared credentials (gh CLI) the bot login IS the operator's login, and author filtering
 *        would silently swallow the operator's genuine replies.
 * INV-7  KEYS are opaque, stable for the item's life, unique within the source, and safe as: a
 *        single unquoted shell token (step-done ${key}), a git ref segment (branch.ts does NOT
 *        strip '#'/'/'), and a URL path segment (evidence S3 key). Sources enforce this at
 *        listEligible (skip + warn on unsafe keys). Prefer the backend's immutable id over mutable
 *        display identifiers (put those in Ticket.displayKey). summary/type must be non-empty.
 * INV-8  BRING YOUR OWN rate limiting + hard timeouts (token bucket, Retry-After). The engine only
 *        shapes volume (once-per-tick listEligible, claim admission, poll/outbox backoffs). A hung
 *        call wedges the whole reconcile tick.
 * INV-9  The configured source NAME (name ?? type, unique per repo) is the durable FK on
 *        runs/intents/questions. Renames strand in-flight runs — treat names as append-only. The
 *        default jira source keeps the name "jira" (db/migrate.ts v6 backfill invariant).
 * INV-10 SINGLE FACTORY PER SOURCE BACKEND: claiming is arbitrated by the local store under the
 *        tick lock; source-side markers (labels, statuses) are PROJECTIONS of the claim, not
 *        locks. Two factories with separate DBs on one backend can double-claim — a documented
 *        deployment constraint, not something implementations can fix.
 * INV-11 describe MAY accept alternate identifiers but MUST return the canonical key — the engine
 *        re-checks active-run dedup against the RETURNED key before claiming.
 */
export interface WorkSource {
  /** Declarative capabilities/ownership. Cheap, constant, side-effect free. */
  readonly spec: WorkSourceSpec;
  /** A BOUNDED batch of eligible (todo) items in claim order — need not be exhaustive (claims are
   *  admission-capped per tick anyway); [] when there's none. MAY throw on hard backend failure:
   *  every caller try/catches per source and degrades to [], so one source's outage never starves
   *  the others. MUST exclude items the factory already moved (INV-1), items that are not
   *  claimable work, and items whose keys violate INV-7 (skip + warn). */
  listEligible(): Promise<MatchItem[]>;
  /** Metadata for one item by key (the manual `claim` path). THROWS for unknown keys, including
   *  "exists but is not claimable work". INV-11. */
  describe(key: string): Promise<Ticket>;
  /** Move an item to a canonical lifecycle state. See TransitionResult + INV-1..3. Never reverse
   *  the backend's own automation (never reopen a closed issue). */
  transition(key: string, to: WorkState): Promise<TransitionResult>;
  /** Write the item's work doc (+ any media) into `memDir` for the fix agent. INV-4. */
  materialize(key: string, memDir: string, log: Logger): Promise<void>;
  /** Describe what materialize wrote (drives @@WORK_DOC@@/@@WORK_DOC_KIND@@). Local-fs-only (may
   *  stat memDirAbs to disambiguate layouts, e.g. task/ vs task.md), never throws, NO network;
   *  must return a sensible default before materialize has run. Async ONLY because every client
   *  is wrapped by instrumentObject's async telemetry proxy — a sync method through the Proxy
   *  would return a Promise typed as its value. */
  workDoc(memDirAbs: string): Promise<WorkDocInfo>;
  /** Post a source-native informational note on the item (Jira comment, local marker file, …).
   *  Operator-facing events only — best-effort, no reply expected, and MARKER-TAGGED (INV-6). */
  postNote(key: string, note: string): Promise<void>;
  /** Post a source-native question for a human. INV-5. MAY throw — posting is retried every tick
   *  until an externalId is stored; StaleItemError when the item is gone. */
  askHuman(input: HumanAskInput): Promise<HumanAskResult>;
  /** Poll the source for a human reply to a previously-posted question. null = none yet (drives
   *  the 60s→5min poll backoff). Anchor on externalId with externalCreatedAt as the deleted-anchor
   *  fallback; assume only append + created-after scan — never thread structure. Drop
   *  marker-bearing artifacts per INV-6 and anything created at/before the question (also guards
   *  the edited-old-comment trap — hence "reply in a NEW comment"). Throws are tolerated (counted
   *  as a poll error with backoff) but must not be routine; StaleItemError escalates. */
  pollHumanReply(input: HumanPollInput): Promise<HumanReply | null>;
  /** Throw with an ACTIONABLE message when misconfigured/unreachable (the `doctor` per-source
   *  check): bad auth vs missing repo vs missing label — say which. */
  health(): Promise<void>;
}

/** A configured source's identity + its live client. Resolved from `run.workSource` (or a belt's
 *  `source`) and threaded through the reconciler for materialize / lifecycle transitions. */
export interface SourceRuntime {
  name: string;
  type: SourceType;
  client: WorkSource;
}

/** A configured belt's resolved config + its loaded `match` predicate (undefined = accept all from
 *  its source). This is the unit the reconciler drives: its ordered `steps`, and `watchPr` (true ⇒
 *  run the token-free PR-watch after the last step). Resolved per run from `run.belt`. */
export interface BeltRuntime extends BeltConfig {
  match?: BeltMatch;
}

export interface GitHubApi {
  prForBranch(repo: string, branch: string): Promise<PrInfo | null>;
  prByNumber(repo: string, prNumber: number): Promise<PrInfo | null>;
  reviewSignature(repo: string, prNumber: number): Promise<ReviewSig>;
  /** Batched state + review signature for many PRs (one GraphQL request per ~25) — the per-tick
   *  bulk fetch for every reviewing/attention run. Unresolvable PRs are absent from the map. */
  prSnapshots(repo: string, prNumbers: number[]): Promise<Map<number, PrSnapshot>>;
  /** The authenticated gh user's login (memoized); null if it can't be determined. */
  currentLogin(): Promise<string | null>;
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
  sources: SourceRuntime[]; // configured work sources
  resolveSource(name: string | null): SourceRuntime | undefined; // by run.workSource; total
  belts: BeltRuntime[]; // configured belts, ordered by priority (asc)
  resolveBelt(name: string | null): BeltRuntime | undefined; // by run.belt; total
  github: GitHubApi;
  git: GitApi;
  log: Logger;
  now: () => number; // epoch seconds
  uid: () => string; // short unique suffix for a run's branch (distinct per claim; see branchName)
  sleep: (ms: number) => Promise<void>;
  rmrf: (path: string) => Promise<void>; // recursive force delete (teardown's defensive dir cleanup)
}

export type { Agent };
