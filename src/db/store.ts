import type { DatabaseSync } from "node:sqlite";
import type {
  Clock,
  EventType,
  EvidenceUpload,
  HumanQuestion,
  HumanQuestionPatch,
  Intent,
  IntentStatus,
  Outcome,
  PendingSignal,
  RepoEvent,
  Run,
  RunPatch,
  RunStep,
  RunStepPatch,
  SourceAuthToken,
  StepName,
  TransitionIntent,
  WorkItem,
  WorkState,
} from "../types.ts";
import { systemClock } from "../types.ts";
import { backoffDelaySeconds, HUMAN_POLL_BACKOFF_CAP_SECONDS, OUTBOX_BACKOFF_CAP_SECONDS } from "../schedule.ts";
import { recordDomainEvent, telemetryEvent } from "../telemetry/index.ts";
import { tx } from "./tx.ts";

interface RunRow {
  id: number;
  repo: string;
  work_source: string | null;
  belt: string | null;
  ticket_key: string;
  summary: string | null;
  issue_type: string | null;
  branch: string | null;
  phase: string;
  step: string | null;
  workspace_id: string | null;
  pane_id: string | null;
  worktree_path: string | null;
  pr_number: number | null;
  resolver_active: number;
  last_thread_sig: string | null;
  attention_reason: string | null;
  attention_reason_code: string | null;
  attention_notified_at: number | null;
  outcome: string | null;
  focus_pending: number;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    repo: r.repo,
    workSource: r.work_source,
    belt: r.belt,
    ticketKey: r.ticket_key,
    summary: r.summary,
    issueType: r.issue_type,
    branch: r.branch,
    phase: r.phase as Run["phase"],
    step: r.step,
    workspaceId: r.workspace_id,
    paneId: r.pane_id,
    worktreePath: r.worktree_path,
    prNumber: r.pr_number,
    resolverActive: r.resolver_active !== 0,
    lastThreadSig: r.last_thread_sig,
    attentionReason: r.attention_reason,
    attentionReasonCode: r.attention_reason_code,
    attentionNotifiedAt: r.attention_notified_at,
    outcome: r.outcome as Outcome | null,
    focusPending: r.focus_pending !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

// Runs are read joined to their pull_request product row (run_products), so toRun() still receives
// pr_number / resolver_active / last_thread_sig — that PR-watch state moved off `runs` into
// run_products (product='pull_request') in migration v18. A run with no PR yet has no row, so the
// LEFT JOIN yields NULL number/signature and COALESCE(active, 0)=0 (resolver idle). Callers keep
// reading run.prNumber / run.resolverActive / run.lastThreadSig exactly as before. Columns are
// qualified with `r.` in WHERE/ORDER BY because run_products also has created_at/updated_at.
const RUN_SELECT =
  "SELECT r.*, rp.number AS pr_number, COALESCE(rp.active, 0) AS resolver_active, rp.signature AS last_thread_sig " +
  "FROM runs r LEFT JOIN run_products rp ON rp.run_id = r.id AND rp.product = 'pull_request'";

interface RunStepRow {
  id: number;
  run_id: number;
  step: string;
  pane_id: string | null;
  session_id: string | null;
  progress_sig: string | null;
  progress_at: number | null;
  baseline_sig: string | null;
  baseline_frozen_at: number | null;
  done: number;
  started_at: number | null;
  done_at: number | null;
  absent_at: number | null;
  pass: number;
  dispatched_at: number | null;
}

function toRunStep(r: RunStepRow): RunStep {
  return {
    id: r.id,
    runId: r.run_id,
    step: r.step as StepName,
    paneId: r.pane_id,
    sessionId: r.session_id,
    progressSig: r.progress_sig,
    progressAt: r.progress_at,
    baselineSig: r.baseline_sig,
    baselineFrozenAt: r.baseline_frozen_at,
    done: r.done !== 0,
    startedAt: r.started_at,
    doneAt: r.done_at,
    absentAt: r.absent_at,
    pass: r.pass,
    dispatchedAt: r.dispatched_at,
  };
}

interface WorkItemRow {
  id: number;
  repo: string;
  source: string;
  key: string;
  title: string | null;
  item_type: string | null;
  path: string | null;
  status: string;
  last_release: string | null;
  created_at: number;
  updated_at: number;
}

function toWorkItem(r: WorkItemRow): WorkItem {
  return {
    id: r.id,
    repo: r.repo,
    source: r.source,
    key: r.key,
    title: r.title,
    itemType: r.item_type,
    path: r.path,
    status: r.status as WorkState,
    lastRelease: r.last_release ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface TransitionIntentRow {
  id: number;
  run_id: number;
  repo: string;
  work_source: string;
  ticket_key: string;
  to_state: string;
  to_status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  stale_at: number | null;
  stale_handled_at: number | null;
}

interface EvidenceUploadRow {
  id: number;
  run_id: number;
  repo: string;
  ticket_key: string;
  key_prefix: string;
  evidence_dir: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  error_kind: string | null;
  notified_at: number | null;
  permanent_failed_at: number | null;
  abandoned_at: number | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

interface SourceAuthRow {
  repo: string;
  source: string;
  method: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  cloud_id: string | null;
  cloud_url: string | null;
  scopes: string | null;
  account_label: string | null;
  created_at: number;
  updated_at: number;
}

/** Enqueue lease for an evidence upload: the CLI's inline attempt runs UNLOCKED in the agent process,
 *  concurrently with the server's Phase 0 flush. Setting next_attempt_at this far out at enqueue keeps
 *  the flush from claiming the row mid inline-upload; a failed inline attempt resets it to the 60s
 *  backoff so the server picks it up promptly, and it doubles as crash-recovery if the CLI dies mid-upload. */
const EVIDENCE_UPLOAD_LEASE_SECONDS = 300;

/** An evidence-upload row still owed to the backend: not delivered and not terminally closed
 *  (permanent config failure / abandoned at teardown or by a superseding re-capture). The pending
 *  predicate every evidence-upload query filters on — one spelling, not seven. */
const EVIDENCE_PENDING_SQL = "delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL";

interface HumanQuestionRow {
  id: number;
  run_id: number;
  repo: string;
  work_source: string;
  ticket_key: string;
  step: string | null;
  question: string;
  status: string;
  external_id: string | null;
  external_created_at: string | null;
  answer: string | null;
  answer_external_id: string | null;
  answer_author: string | null;
  poll_attempts: number;
  poll_errors: number;
  next_poll_at: number;
  created_at: number;
  updated_at: number;
  answered_at: number | null;
}

function toHumanQuestion(r: HumanQuestionRow): HumanQuestion {
  return {
    id: r.id,
    runId: r.run_id,
    repo: r.repo,
    workSource: r.work_source,
    ticketKey: r.ticket_key,
    step: r.step,
    question: r.question,
    status: r.status as HumanQuestion["status"],
    externalId: r.external_id,
    externalCreatedAt: r.external_created_at,
    answer: r.answer,
    answerExternalId: r.answer_external_id,
    answerAuthor: r.answer_author,
    pollAttempts: r.poll_attempts,
    pollErrors: r.poll_errors,
    nextPollAt: r.next_poll_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    answeredAt: r.answered_at,
  };
}

interface IntentRow {
  id: number;
  repo: string;
  kind: string;
  scope: string;
  run_id: number | null;
  ticket_key: string | null;
  dedup_key: string;
  seq: number;
  payload: string;
  state: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  deadline_at: number | null;
  last_error: string | null;
  error_class: string | null;
  cause_scope: string | null;
  notified_at: number | null;
  handoff_at: number | null;
  handoff_marker: string | null;
  consumed_at: number | null;
  consumed_result: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

function toIntent(r: IntentRow): Intent {
  return {
    id: r.id,
    repo: r.repo,
    kind: r.kind,
    scope: r.scope,
    runId: r.run_id,
    ticketKey: r.ticket_key,
    dedupKey: r.dedup_key,
    seq: r.seq,
    payload: r.payload,
    state: r.state,
    status: r.status as Intent["status"],
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    leaseUntil: r.lease_until,
    deadlineAt: r.deadline_at,
    lastError: r.last_error,
    errorClass: r.error_class as Intent["errorClass"],
    causeScope: r.cause_scope,
    notifiedAt: r.notified_at,
    handoffAt: r.handoff_at,
    handoffMarker: r.handoff_marker,
    consumedAt: r.consumed_at,
    consumedResult: r.consumed_result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

interface PendingSignalRow {
  id: number;
  run_id: number;
  repo: string;
  ticket_key: string;
  signal: string;
  step: string | null;
  to_step: string | null;
  payload: string;
  pass: number | null;
  created_at: number;
  consumed_at: number | null;
  consumed_result: string | null;
}

function toPendingSignal(r: PendingSignalRow): PendingSignal {
  return {
    id: r.id,
    runId: r.run_id,
    repo: r.repo,
    ticketKey: r.ticket_key,
    signal: r.signal as PendingSignal["signal"],
    step: r.step,
    toStep: r.to_step,
    payload: r.payload,
    pass: r.pass,
    createdAt: r.created_at,
    consumedAt: r.consumed_at,
    consumedResult: r.consumed_result,
  };
}

type Bind = string | number | null;
const patchFields = (patch: Record<string, unknown>): string[] => Object.keys(patch).filter((k) => patch[k] !== undefined).sort();

/** True when `e` is a SQLite UNIQUE-constraint violation. node:sqlite surfaces it as errcode 2067
 *  (SQLITE_CONSTRAINT_UNIQUE) with a "UNIQUE constraint failed: …" message — check both so a
 *  wrapped/re-thrown error still matches on the message. Callers use this to treat losing an
 *  insert race (e.g. createRun vs the v25 one-active-run-per-item index) as data, not failure. */
export function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ((e as { errcode?: number }).errcode === 2067) return true;
  return e.message.startsWith("UNIQUE constraint failed");
}

/** Per-process counter for agent-signal dedup keys (unique alongside the pid — see
 *  enqueuePendingSignal; single-slot semantics come from supersession, not the key). */
let signalSeq = 0;

/** Typed repository over the SQLite DB. All methods are synchronous. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly now: Clock;
  constructor(db: DatabaseSync, now: Clock = systemClock) {
    this.db = db;
    this.now = now;
  }

  countActive(repo: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE repo = ? AND ended_at IS NULL")
      .get(repo) as { n: number };
    return row.n;
  }

  /** Runs actually consuming a machine slot, counted against max_active_workspaces. A slot is held
   *  by a run that is actively being worked: claiming/running/tearing_down always, plus a
   *  `reviewing` run ONLY while its resolver is actively addressing review comments
   *  (resolver_active). Runs that hold their worktree but do no work hold no slot — the parks
   *  (attention, waiting_for_human) and an idle PR-watch (reviewing with no active resolver) — so
   *  neither a pile of human-blocked runs nor a long-lived PR in review starves the belt of new
   *  claims. This is what lets the PR watch ride with no time limit (there is no watch_hours). */
  countOccupying(repo: string): number {
    // Joins run_products so a `reviewing` run occupies a slot only while its pull_request watch is
    // active (COALESCE(rp.active,0)) — the idleHoldsSlot=false posture. A future plugin watch-product
    // would plug its declared occupancy posture in here rather than hardcoding 'pull_request'.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs r
         LEFT JOIN run_products rp ON rp.run_id = r.id AND rp.product = 'pull_request'
         WHERE r.repo = ? AND r.ended_at IS NULL
           AND r.phase NOT IN ('attention', 'waiting_for_human')
           AND NOT (r.phase = 'reviewing' AND COALESCE(rp.active, 0) = 0)`,
      )
      .get(repo) as { n: number };
    return row.n;
  }

  /** Occupying-run counts (same posture as countOccupying) grouped by `work_source` — the per-source
   *  concurrency accounting Phase B checks against each source's `max_active_workspaces`. Sources with
   *  zero occupying runs are simply absent from the map (callers default a miss to 0). */
  countOccupyingBySource(repo: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT r.work_source AS source, COUNT(*) AS n FROM runs r
         LEFT JOIN run_products rp ON rp.run_id = r.id AND rp.product = 'pull_request'
         WHERE r.repo = ? AND r.ended_at IS NULL
           AND r.phase NOT IN ('attention', 'waiting_for_human')
           AND NOT (r.phase = 'reviewing' AND COALESCE(rp.active, 0) = 0)
         GROUP BY r.work_source`,
      )
      .all(repo) as { source: string | null; n: number }[];
    const counts = new Map<string, number>();
    for (const { source, n } of rows) if (source != null) counts.set(source, n);
    return counts;
  }

  activeRuns(repo: string): Run[] {
    const rows = this.db
      .prepare(`${RUN_SELECT} WHERE r.repo = ? AND r.ended_at IS NULL ORDER BY r.created_at`)
      .all(repo) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** The active run for a ticket WITHIN a source — the Phase-B dedup key. Scoped by source so
   *  two sources can legitimately carry the same key (e.g. a Jira ticket and a like-named .md). */
  activeRunForTicket(repo: string, source: string, key: string): Run | undefined {
    const row = this.db
      .prepare(`${RUN_SELECT} WHERE r.repo = ? AND r.work_source = ? AND r.ticket_key = ? AND r.ended_at IS NULL`)
      .get(repo, source, key) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** The active run whose worktree branch matches — how the layout hook tells a factory-created
   *  worktree (use that run's belt for layout selection) from a hand-made one (walk belts). Branches
   *  carry a per-claim uid suffix, so this is effectively unique among active runs. */
  activeRunForBranch(repo: string, branch: string): Run | undefined {
    const row = this.db
      .prepare(`${RUN_SELECT} WHERE r.repo = ? AND r.branch = ? AND r.ended_at IS NULL`)
      .get(repo, branch) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** All active runs for a ticket key, across sources — for the manual CLI (claim/teardown/
   *  step-done) which is given only a key. The caller errors when this returns >1 (ambiguous). */
  activeRunsForKey(repo: string, key: string): Run[] {
    const rows = this.db
      .prepare(`${RUN_SELECT} WHERE r.repo = ? AND r.ticket_key = ? AND r.ended_at IS NULL ORDER BY r.id`)
      .all(repo, key) as unknown as RunRow[];
    return rows.map(toRun);
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Active (in-flight) runs on a belt — the belt-delete guard's input. "In progress" here is any
   *  run with ended_at IS NULL, INCLUDING parked attention/waiting_for_human runs (they still hold
   *  a worktree and are mid-flight), not just the working ones countOccupying counts. */
  activeRunsForBelt(repo: string, belt: string): Run[] {
    const rows = this.db
      .prepare(`${RUN_SELECT} WHERE r.repo = ? AND r.belt = ? AND r.ended_at IS NULL ORDER BY r.id`)
      .all(repo, belt) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** Ended runs on a belt that still show a herdr workspace / checkout dir — the defensive
   *  worktree-cleanup input at belt deletion. Teardown normally reaps these at run end, so a hit
   *  here is a leak (a teardown that partially failed); belt deletion clears it as a backstop. */
  endedRunsForBelt(repo: string, belt: string): Run[] {
    const rows = this.db
      .prepare(
        `${RUN_SELECT} WHERE r.repo = ? AND r.belt = ? AND r.ended_at IS NOT NULL
         AND (r.workspace_id IS NOT NULL OR r.worktree_path IS NOT NULL) ORDER BY r.id`,
      )
      .all(repo, belt) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** Move every run (active AND historical) from one belt name to another — the belt-rename
   *  migration. runs.belt is otherwise written only at createRun; this is its one later mutation.
   *  Returns how many rows moved (0 ⇒ already migrated / no such belt — idempotent). The caller
   *  runs this under the repo tick lock and reloads Deps atomically after, so no reconcile pass
   *  ever sees a run whose new belt name isn't yet configured. */
  reassignBelt(repo: string, from: string, to: string): number {
    const info = this.db
      .prepare("UPDATE runs SET belt = ?, updated_at = ? WHERE repo = ? AND belt = ?")
      .run(to, this.now(), repo, from);
    const moved = Number(info.changes);
    telemetryEvent("store.belt.reassign", { repo, "belt.from": from, "belt.to": to, "runs.moved": moved });
    return moved;
  }

  /** Purge a belt's run rows and every run-referencing child row, KEEPING the events timeline.
   *  events.run_id is REFERENCES runs(id) and foreign_keys is ON, so the audit rows are DETACHED
   *  (run_id → NULL, exempt from the FK) rather than deleted — their repo/ticket_key/ts/type/detail
   *  survive for audit. Every other child table's rows ARE deleted (some carry the FK; run_steps
   *  doesn't but is cleaned anyway) so no orphaned outbox intent lingers to retry against a deleted
   *  run. Caller MUST have verified the belt has no active runs. Returns the run count purged. */
  purgeBeltRuns(repo: string, belt: string): number {
    return tx(this.db, () => {
      const ids = (this.db.prepare("SELECT id FROM runs WHERE repo = ? AND belt = ?").all(repo, belt) as { id: number }[]).map((r) => r.id);
      if (ids.length === 0) return 0;
      const ph = ids.map(() => "?").join(",");
      // Detach (keep) the timeline; the FK on events(run_id) permits NULL, so the rows survive.
      this.db.prepare(`UPDATE events SET run_id = NULL WHERE run_id IN (${ph})`).run(...ids);
      // Delete every run-scoped child row. Table names are a fixed internal list (never user input).
      for (const table of ["run_steps", "run_products", "guard_counters", "transition_outbox", "evidence_uploads", "human_questions", "pending_signals", "intents"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE run_id IN (${ph})`).run(...ids);
      }
      this.db.prepare(`DELETE FROM runs WHERE id IN (${ph})`).run(...ids);
      telemetryEvent("store.belt.purge", { repo, belt, "runs.purged": ids.length });
      return ids.length;
    });
  }

  createRun(input: {
    repo: string;
    workSource: string;
    belt: string;
    ticketKey: string;
    summary?: string | null;
    issueType?: string | null;
    branch?: string | null;
  }): Run {
    const t = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO runs (repo, work_source, belt, ticket_key, summary, issue_type, branch, phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'claiming', ?, ?)`,
      )
      .run(input.repo, input.workSource, input.belt, input.ticketKey, input.summary ?? null, input.issueType ?? null, input.branch ?? null, t, t);
    const run = this.getRun(Number(info.lastInsertRowid));
    if (!run) throw new Error("createRun: row vanished after insert");
    telemetryEvent("store.run.create", {
      repo: run.repo,
      "run.id": run.id,
      "work.source": run.workSource ?? undefined,
      belt: run.belt ?? undefined,
      "work.key": run.ticketKey,
      phase: run.phase,
    });
    return run;
  }

  updateRun(id: number, patch: RunPatch): void {
    const sets: string[] = [];
    const vals: Bind[] = [];
    const set = (col: string, v: Bind) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.phase !== undefined) set("phase", patch.phase);
    if (patch.step !== undefined) set("step", patch.step);
    if (patch.branch !== undefined) set("branch", patch.branch);
    if (patch.summary !== undefined) set("summary", patch.summary);
    if (patch.issueType !== undefined) set("issue_type", patch.issueType);
    if (patch.workspaceId !== undefined) set("workspace_id", patch.workspaceId);
    if (patch.paneId !== undefined) set("pane_id", patch.paneId);
    if (patch.worktreePath !== undefined) set("worktree_path", patch.worktreePath);
    if (patch.attentionReason !== undefined) set("attention_reason", patch.attentionReason);
    if (patch.attentionReasonCode !== undefined) set("attention_reason_code", patch.attentionReasonCode);
    if (patch.attentionNotifiedAt !== undefined) set("attention_notified_at", patch.attentionNotifiedAt);
    if (patch.outcome !== undefined) set("outcome", patch.outcome);
    if (patch.focusPending !== undefined) set("focus_pending", patch.focusPending ? 1 : 0);
    // PR-watch state lives in run_products (v18), not on `runs` — route those three fields there.
    const prod: { number?: number | null; active?: boolean; signature?: string | null } = {};
    if (patch.prNumber !== undefined) prod.number = patch.prNumber;
    if (patch.resolverActive !== undefined) prod.active = patch.resolverActive;
    if (patch.lastThreadSig !== undefined) prod.signature = patch.lastThreadSig;
    const hasProd = prod.number !== undefined || prod.active !== undefined || prod.signature !== undefined;
    if (sets.length === 0 && !hasProd) return;
    if (hasProd) this.setRunProduct(id, "pull_request", prod);
    if (sets.length > 0) {
      set("updated_at", this.now());
      this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    } else {
      // product-only patch: still bump the run's mtime so it reflects the change.
      this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(this.now(), id);
    }
    const run = this.getRun(id);
    telemetryEvent("store.run.update", {
      repo: run?.repo,
      "run.id": id,
      "work.key": run?.ticketKey,
      phase: run?.phase,
      step: run?.step ?? undefined,
      outcome: run?.outcome ?? undefined,
      "patch.fields": patchFields(patch),
    });
  }

  /** Upsert a run's per-product watch state (run_products, v18) — the store-layer backing for a
   *  run's prNumber/resolverActive/lastThreadSig, keyed by product so a future plugin watch-product
   *  carries its own. Partial: only the provided fields change; the row is created on first touch. */
  private setRunProduct(runId: number, product: string, patch: { number?: number | null; active?: boolean; signature?: string | null }): void {
    const t = this.now();
    const exists = this.db.prepare("SELECT 1 FROM run_products WHERE run_id = ? AND product = ?").get(runId, product);
    if (!exists) {
      this.db
        .prepare("INSERT INTO run_products (run_id, product, number, active, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, product, patch.number ?? null, patch.active ? 1 : 0, patch.signature ?? null, t, t);
      return;
    }
    const sets: string[] = [];
    const vals: Bind[] = [];
    if (patch.number !== undefined) {
      sets.push("number = ?");
      vals.push(patch.number);
    }
    if (patch.active !== undefined) {
      sets.push("active = ?");
      vals.push(patch.active ? 1 : 0);
    }
    if (patch.signature !== undefined) {
      sets.push("signature = ?");
      vals.push(patch.signature);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    vals.push(t);
    this.db.prepare(`UPDATE run_products SET ${sets.join(", ")} WHERE run_id = ? AND product = ?`).run(...vals, runId, product);
  }

  endRun(id: number, outcome: Outcome): void {
    const t = this.now();
    this.db
      .prepare("UPDATE runs SET phase = 'done', outcome = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(outcome, t, t, id);
    const run = this.getRun(id);
    telemetryEvent("store.run.end", { repo: run?.repo, "run.id": id, "work.key": run?.ticketKey, outcome });
  }

  recordEvent(e: {
    runId?: number | null;
    repo: string;
    ticketKey?: string | null;
    type: EventType;
    detail?: unknown;
  }): void {
    this.db
      .prepare("INSERT INTO events (run_id, repo, ticket_key, ts, type, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        e.runId ?? null,
        e.repo,
        e.ticketKey ?? null,
        this.now(),
        e.type,
        e.detail === undefined ? null : JSON.stringify(e.detail),
      );
    const attrs = { repo: e.repo, "run.id": e.runId ?? undefined, "work.key": e.ticketKey ?? undefined, "event.type": e.type };
    telemetryEvent(`domain.${e.type}`, attrs);
    recordDomainEvent(e.type, attrs);
  }

  /** TTL lock; steals an expired holder. Atomic. */
  acquireLock(name: string, owner: string, ttlSec: number): boolean {
    const now = this.now();
    const acquired = tx(this.db, (): boolean => {
      const row = this.db.prepare("SELECT expires_at FROM locks WHERE name = ?").get(name) as
        | { expires_at: number }
        | undefined;
      if (row && row.expires_at > now) return false;
      this.db
        .prepare(
          `INSERT INTO locks (name, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        )
        .run(name, owner, now, now + ttlSec);
      return true;
    });
    telemetryEvent("store.lock.acquire", { "lock.name": name, "lock.owner": owner, "lock.acquired": acquired, "lock.ttl_sec": ttlSec });
    return acquired;
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
    telemetryEvent("store.lock.release", { "lock.name": name, "lock.owner": owner });
  }

  /** Push a HELD lock's expiry out (the keep-alive heartbeat). Owner-checked: returns false when
   *  the lock isn't currently ours (expired and re-acquired by someone else) — the holder must
   *  treat that as lost, not re-assert it. */
  extendLock(name: string, owner: string, ttlSec: number): boolean {
    const info = this.db
      .prepare("UPDATE locks SET expires_at = ? WHERE name = ? AND owner = ?")
      .run(this.now() + ttlSec, name, owner);
    return Number(info.changes) > 0;
  }

  upsertRepo(name: string, repoPath: string, baseRef: string | null, github: string | null): void {
    this.db
      .prepare(
        `INSERT INTO repos (name, repo_path, base_ref, github) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET repo_path = excluded.repo_path, base_ref = excluded.base_ref, github = excluded.github`,
      )
      .run(name, repoPath, baseRef, github);
    telemetryEvent("store.repo.upsert", { repo: name, "git.base_ref": baseRef ?? undefined, "github.repo": github ?? undefined });
  }

  touchTick(repo: string): void {
    this.db.prepare("UPDATE repos SET last_tick_at = ? WHERE name = ?").run(this.now(), repo);
    telemetryEvent("store.repo.touch_tick", { repo });
  }

  /** When the repo's last reconcile pass COMPLETED (epoch seconds) — the tick-watchdog signal
   *  the supervisor restarts on when it goes stale (a wedged tick stops touching it). */
  lastTickAt(repo: string): number | null {
    const row = this.db.prepare("SELECT last_tick_at FROM repos WHERE name = ?").get(repo) as
      | { last_tick_at: number | null }
      | undefined;
    return row?.last_tick_at ?? null;
  }

  listRuns(repo: string, includeEnded: boolean): Run[] {
    const sql = includeEnded
      ? "SELECT * FROM runs WHERE repo = ? ORDER BY created_at DESC LIMIT 100"
      : "SELECT * FROM runs WHERE repo = ? AND ended_at IS NULL ORDER BY created_at";
    return (this.db.prepare(sql).all(repo) as unknown as RunRow[]).map(toRun);
  }

  /** Events for a ticket's most recent run (the timeline). */
  timeline(repo: string, ticketKey: string): { ts: number; type: string; detail: string | null }[] {
    const r = this.db
      .prepare("SELECT id FROM runs WHERE repo = ? AND ticket_key = ? ORDER BY id DESC LIMIT 1")
      .get(repo, ticketKey) as { id: number } | undefined;
    if (!r) return [];
    return this.db.prepare("SELECT ts, type, detail FROM events WHERE run_id = ? ORDER BY id").all(r.id) as {
      ts: number;
      type: string;
      detail: string | null;
    }[];
  }

  /** The current max event id for a repo — the seed for the foreground `run --follow` feed, so it
   *  streams only events created after it started rather than replaying the whole history. 0 when
   *  the repo has no events yet. */
  maxEventId(repo: string): number {
    const row = this.db.prepare("SELECT MAX(id) AS n FROM events WHERE repo = ?").get(repo) as { n: number | null };
    return row.n ?? 0;
  }

  /** Repo-wide events created after `afterId`, oldest-first — the incremental feed the foreground
   *  `run` command tails. Unlike `timeline` (one ticket's run) this spans every run in the repo and
   *  includes run-id-less admin events (belt rename/delete). */
  eventsSince(repo: string, afterId: number): RepoEvent[] {
    return this.db
      .prepare("SELECT id, ts, type, detail, ticket_key AS ticketKey FROM events WHERE repo = ? AND id > ? ORDER BY id")
      .all(repo, afterId) as unknown as RepoEvent[];
  }

  /** The machine `reason` of the run's most recent `attention` escalation. Lets reconcileAttention
   *  tell an auto-rescuable park apart from a human-only one: a step-execution watchdog park
   *  (evidence capture cap / per-step budget / stall / read-only violation) is rescued by a genuine
   *  step-done, a layout-wait park by the bounded spawn re-attempt, and a source-stale / pr-closed /
   *  bounce / human / config park only by a human. First-class on the run row since v28
   *  (backfilled from the events log); the event-log readback below stays as the fallback for one
   *  release — a park written by a still-draining OLD-code process during the upgrade window has no
   *  column value, and routing state must not silently vanish for it. null if the run was never
   *  parked (or the reason is unrecorded). */
  lastAttentionReasonCode(runId: number): string | null {
    const run = this.db.prepare("SELECT attention_reason_code AS c FROM runs WHERE id = ?").get(runId) as { c: string | null } | undefined;
    if (run?.c) return run.c;
    const row = this.db
      .prepare("SELECT detail FROM events WHERE run_id = ? AND type = 'attention' ORDER BY id DESC LIMIT 1")
      .get(runId) as { detail: string | null } | undefined;
    if (!row?.detail) return null;
    try {
      const reason = (JSON.parse(row.detail) as { reason?: unknown }).reason;
      return typeof reason === "string" ? reason : null;
    } catch {
      return null;
    }
  }

  // --- run steps (one row per belt step the run has reached) ------------------

  getRunStep(runId: number, step: StepName): RunStep | undefined {
    const row = this.db
      .prepare("SELECT * FROM run_steps WHERE run_id = ? AND step = ?")
      .get(runId, step) as RunStepRow | undefined;
    return row ? toRunStep(row) : undefined;
  }

  runStepsFor(runId: number): RunStep[] {
    return (this.db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY id").all(runId) as unknown as RunStepRow[]).map(
      toRunStep,
    );
  }

  /** Insert the step row if missing, then apply the patch. Returns the fresh row. The insert is
   *  atomic against the v25 UNIQUE(run_id, step) index: markStepDone runs outside the run lock, so
   *  a cross-process racer must lose the insert cleanly (ON CONFLICT DO NOTHING) instead of
   *  double-inserting the row the old read-then-insert could produce. */
  upsertRunStep(runId: number, step: StepName, patch: RunStepPatch = {}): RunStep {
    const info = this.db
      .prepare("INSERT INTO run_steps (run_id, step, started_at) VALUES (?, ?, ?) ON CONFLICT(run_id, step) DO NOTHING")
      .run(runId, step, this.now());
    const created = Number(info.changes) > 0;
    const sets: string[] = [];
    const vals: Bind[] = [];
    const set = (col: string, v: Bind) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.paneId !== undefined) set("pane_id", patch.paneId);
    if (patch.sessionId !== undefined) set("session_id", patch.sessionId);
    if (patch.progressSig !== undefined) set("progress_sig", patch.progressSig);
    if (patch.progressAt !== undefined) set("progress_at", patch.progressAt);
    if (patch.baselineSig !== undefined) set("baseline_sig", patch.baselineSig);
    if (patch.baselineFrozenAt !== undefined) set("baseline_frozen_at", patch.baselineFrozenAt);
    if (patch.startedAt !== undefined) set("started_at", patch.startedAt);
    if (patch.absentAt !== undefined) set("absent_at", patch.absentAt);
    if (patch.pass !== undefined) set("pass", patch.pass);
    if (patch.dispatchedAt !== undefined) set("dispatched_at", patch.dispatchedAt);
    if (patch.done !== undefined) {
      set("done", patch.done ? 1 : 0);
      set("done_at", patch.done ? this.now() : null);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE run_steps SET ${sets.join(", ")} WHERE run_id = ? AND step = ?`).run(...vals, runId, step);
    }
    const row = this.getRunStep(runId, step)!;
    telemetryEvent("store.run_step.upsert", {
      "run.id": runId,
      step,
      "step.created": created,
      "step.done": row.done,
      "herdr.pane_id": row.paneId ?? undefined,
      "patch.fields": patchFields(patch),
    });
    return row;
  }

  markStepDone(runId: number, step: StepName): void {
    this.upsertRunStep(runId, step, { done: true });
    telemetryEvent("store.run_step.done", { "run.id": runId, step });
  }

  /** Increment (and return) a capped guard's counter, keyed (run, step, guard) in `guard_counters` so
   *  any number of capped guards on one step count independently (this generalizes the old
   *  single-purpose run_steps.bounces / capture_attempts columns). The bounce cap uses guard
   *  'bounce_cap' keyed on the TARGET step; the evidence capture cap uses 'capture_cap' keyed on the
   *  step itself. The reconciler escalates once the returned count exceeds the guard's configured limit. */
  bumpGuardCounter(runId: number, step: StepName, guard: string): number {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO guard_counters (run_id, step, guard, count, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(run_id, step, guard) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
      )
      .run(runId, step, guard, now);
    const row = this.db.prepare("SELECT count FROM guard_counters WHERE run_id = ? AND step = ? AND guard = ?").get(runId, step, guard) as { count: number };
    telemetryEvent("store.guard_counter.bump", { "run.id": runId, step, guard, count: row.count });
    return row.count;
  }

  /** The current value of a (run, step, guard) counter (0 when none has been recorded). */
  guardCounter(runId: number, step: StepName, guard: string): number {
    const row = this.db.prepare("SELECT count FROM guard_counters WHERE run_id = ? AND step = ? AND guard = ?").get(runId, step, guard) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Reset a (run, step, guard) counter — the capture cap's forward-entry reset (a fresh pass into the
   *  step gets a full budget) and the human-resume reset. A no-op when nothing is counted, so it is
   *  safe to call unconditionally (fixing the old leak where resume reset capture_attempts even for a
   *  step that never gathers evidence). */
  resetGuardCounter(runId: number, step: StepName, guard: string): void {
    this.db.prepare("DELETE FROM guard_counters WHERE run_id = ? AND step = ? AND guard = ?").run(runId, step, guard);
  }

  // --- transition outbox (source status write-backs, retried until delivered) --

  private toTransitionIntent(r: TransitionIntentRow): TransitionIntent {
    return {
      id: r.id,
      runId: r.run_id,
      repo: r.repo,
      workSource: r.work_source,
      ticketKey: r.ticket_key,
      toState: r.to_state as WorkState,
      toStatus: r.to_status,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deliveredAt: r.delivered_at,
      staleAt: r.stale_at,
      staleHandledAt: r.stale_handled_at,
    };
  }

  getTransitionIntent(id: number): TransitionIntent | undefined {
    const row = this.db.prepare("SELECT * FROM transition_outbox WHERE id = ?").get(id) as TransitionIntentRow | undefined;
    return row ? this.toTransitionIntent(row) : undefined;
  }

  /** Record the INTENT to move a work item to `toState` (with an optional source-native `toStatus`
   *  key from a belt effect; '' = canonical mapping). Idempotent per (run, state, status):
   *  re-enqueueing a delivered intent re-opens it for delivery (the transition itself is idempotent
   *  at the source), re-enqueueing a pending one just makes it due now. A custom status and a
   *  canonical transition at the same anchor are DISTINCT intents (they differ in `toStatus`). */
  enqueueTransition(input: {
    runId: number;
    repo: string;
    workSource: string;
    ticketKey: string;
    toState: WorkState;
    toStatus?: string;
  }): TransitionIntent {
    const t = this.now();
    const toStatus = input.toStatus ?? "";
    this.db
      .prepare(
        `INSERT INTO transition_outbox (run_id, repo, work_source, ticket_key, to_state, to_status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(run_id, to_state, to_status) DO UPDATE SET next_attempt_at = excluded.next_attempt_at, delivered_at = NULL,
           stale_at = NULL, stale_handled_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(input.runId, input.repo, input.workSource, input.ticketKey, input.toState, toStatus, t, t, t);
    const row = this.db
      .prepare("SELECT * FROM transition_outbox WHERE run_id = ? AND to_state = ? AND to_status = ?")
      .get(input.runId, input.toState, toStatus) as TransitionIntentRow | undefined;
    if (!row) throw new Error("enqueueTransition: row vanished after upsert");
    telemetryEvent("store.transition.enqueue", { repo: input.repo, "run.id": input.runId, "work.key": input.ticketKey, "work.state": input.toState, "work.status": toStatus || undefined });
    return this.toTransitionIntent(row);
  }

  /** Every transition target ENQUEUED for a run (delivered or pending), for effect monotonicity:
   *  the reconciler ranks these to refuse an effect that would walk the source backward. */
  transitionTargetsForRun(runId: number): { toState: WorkState; toStatus: string }[] {
    const rows = this.db
      .prepare("SELECT to_state, to_status FROM transition_outbox WHERE run_id = ?")
      .all(runId) as { to_state: string; to_status: string }[];
    return rows.map((r) => ({ toState: r.to_state as WorkState, toStatus: r.to_status }));
  }

  /** Undelivered intents due for a delivery attempt, ordered (run, id) so a run's transitions
   *  are always attempted in the order they were intended. */
  dueTransitions(repo: string, limit = 25): TransitionIntent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM transition_outbox WHERE repo = ? AND delivered_at IS NULL AND next_attempt_at <= ? ORDER BY run_id, id LIMIT ?",
      )
      .all(repo, this.now(), limit) as unknown as TransitionIntentRow[];
    return rows.map((r) => this.toTransitionIntent(r));
  }

  /** Is an EARLIER intent for this run still undelivered? Delivery must be in-order per run (a
   *  retried in_development firing after in_review landed would walk the source backward). */
  undeliveredTransitionBefore(runId: number, beforeId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM transition_outbox WHERE run_id = ? AND id < ? AND delivered_at IS NULL LIMIT 1")
      .get(runId, beforeId) as { x: number } | undefined;
    return row !== undefined;
  }

  markTransitionDelivered(id: number): void {
    const t = this.now();
    // last_error is left as-is: with delivered_at set it reads as history ("delivered after N
    // failed attempts, last of which was …"), and the source-removed close-out relies on it.
    this.db.prepare("UPDATE transition_outbox SET delivered_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
    const e = this.getTransitionIntent(id);
    telemetryEvent("store.transition.delivered", { repo: e?.repo, "run.id": e?.runId, "work.key": e?.ticketKey, "work.state": e?.toState });
  }

  /** Record a failed delivery attempt: bump the counter and push next_attempt_at out with
   *  exponential backoff (60s doubling, capped at 1h). Never gives up — the intent stays visible
   *  and retried until the source accepts it or the entry is superseded by an operator. */
  recordTransitionAttempt(id: number, error: string): TransitionIntent {
    const t = this.now();
    const current = this.getTransitionIntent(id);
    const attempts = (current?.attempts ?? 0) + 1;
    const delay = backoffDelaySeconds(attempts, OUTBOX_BACKOFF_CAP_SECONDS);
    this.db
      .prepare("UPDATE transition_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, t + delay, error.slice(0, 500), t, id);
    const e = this.getTransitionIntent(id)!;
    telemetryEvent("store.transition.attempt_failed", {
      repo: e.repo,
      "run.id": e.runId,
      "work.key": e.ticketKey,
      "work.state": e.toState,
      "transition.attempts": attempts,
    });
    return e;
  }

  /** Delivery reported the item STALE (deleted/transferred — retrying cannot help). Marks the
   *  intent delivered so the outbox stops retrying, and stamps stale_at for the run-locked
   *  Phase A policy to consume. Called from the LOCK-FREE outbox flush — no run mutation here. */
  markTransitionStale(id: number, detail: string): void {
    const t = this.now();
    this.db
      .prepare("UPDATE transition_outbox SET delivered_at = ?, stale_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(t, t, detail.slice(0, 500), t, id);
    const e = this.getTransitionIntent(id);
    telemetryEvent("store.transition.stale", {
      repo: e?.repo,
      "run.id": e?.runId,
      "work.key": e?.ticketKey,
      "work.state": e?.toState,
    });
  }

  /** The oldest unconsumed stale intent for a run, if any — Phase A's per-run stale policy input. */
  unhandledStaleIntentForRun(runId: number): TransitionIntent | undefined {
    const row = this.db
      .prepare("SELECT * FROM transition_outbox WHERE run_id = ? AND stale_at IS NOT NULL AND stale_handled_at IS NULL ORDER BY id LIMIT 1")
      .get(runId) as TransitionIntentRow | undefined;
    return row ? this.toTransitionIntent(row) : undefined;
  }

  /** Stamp a stale intent consumed (abort/park applied — or deliberately ignored for an ended
   *  run) so it never fires the policy twice. */
  markTransitionStaleHandled(id: number): void {
    const t = this.now();
    this.db.prepare("UPDATE transition_outbox SET stale_handled_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
  }

  /** On auth RECOVERY for a source: make all its undelivered write-backs due now, so a restored
   *  session flushes them on the next tick's Phase 0 instead of waiting out the exponential backoff
   *  they accrued while the source was unauthenticated. Harmless if some were merely network-flaky
   *  (they just retry a little sooner). Returns how many were re-queued. */
  retryTransitionsForSource(repo: string, source: string): number {
    const t = this.now();
    const info = this.db
      .prepare("UPDATE transition_outbox SET next_attempt_at = ?, updated_at = ? WHERE repo = ? AND work_source = ? AND delivered_at IS NULL")
      .run(t, t, repo, source);
    return Number(info.changes);
  }

  /** A run's outstanding write-back obligations: every undelivered intent, plus a delivered-but-
   *  stale one whose run-locked policy reaction is still owed (stale_at set, unhandled). Read-only —
   *  the obligations introspection view (core/obligations.ts). */
  pendingTransitionsForRun(runId: number): TransitionIntent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM transition_outbox WHERE run_id = ?
         AND (delivered_at IS NULL OR (stale_at IS NOT NULL AND stale_handled_at IS NULL)) ORDER BY id`,
      )
      .all(runId) as unknown as TransitionIntentRow[];
    return rows.map((r) => this.toTransitionIntent(r));
  }

  /** Does this work item have any undelivered status write-back? While it does, the item's
   *  source status is known-stale — Phase B must not trust an "eligible" listing for it. */
  pendingTransitionForKey(repo: string, source: string, key: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM transition_outbox WHERE repo = ? AND work_source = ? AND ticket_key = ? AND delivered_at IS NULL LIMIT 1")
      .get(repo, source, key) as { x: number } | undefined;
    return row !== undefined;
  }

  // --- source OAuth tokens (auth.method: oauth) -----------------------------
  // Per-(repo, source) stored credentials. api_token sources never touch this table. `auth login`
  // writes here (possibly from a different process than the running server — WAL + busy_timeout make
  // that safe); the JiraOAuthAuth provider reads FRESH on each authorize() so a login lands without a
  // restart, and overwrites the rotated refresh_token on each refresh.

  private toSourceAuth(r: SourceAuthRow): SourceAuthToken {
    return {
      repo: r.repo,
      source: r.source,
      method: r.method,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: r.expires_at,
      cloudId: r.cloud_id,
      cloudUrl: r.cloud_url,
      scopes: r.scopes,
      accountLabel: r.account_label,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  getSourceAuth(repo: string, source: string): SourceAuthToken | undefined {
    const row = this.db.prepare("SELECT * FROM source_auth WHERE repo = ? AND source = ?").get(repo, source) as SourceAuthRow | undefined;
    return row ? this.toSourceAuth(row) : undefined;
  }

  /** Upsert a source's stored credentials (a fresh login, or a rotated refresh). created_at is kept
   *  on update so it reads as "first authenticated at". */
  saveSourceAuth(input: {
    repo: string;
    source: string;
    method: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
    cloudId: string | null;
    cloudUrl: string | null;
    scopes: string | null;
  }): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO source_auth (repo, source, method, access_token, refresh_token, expires_at, cloud_id, cloud_url, scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, source) DO UPDATE SET method = excluded.method, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, cloud_id = excluded.cloud_id,
           cloud_url = excluded.cloud_url, scopes = excluded.scopes, updated_at = excluded.updated_at`,
      )
      .run(input.repo, input.source, input.method, input.accessToken, input.refreshToken, input.expiresAt, input.cloudId, input.cloudUrl, input.scopes, t, t);
    telemetryEvent("store.source_auth.saved", { repo: input.repo, "work.source": input.source, "auth.method": input.method });
  }

  /** Record the authenticated account label (whoami displayName/email) for a source — set post-login,
   *  and preserved across token refreshes (it isn't part of saveSourceAuth's upsert). No-op if the
   *  source has no stored row yet. */
  setSourceAuthAccount(repo: string, source: string, accountLabel: string): void {
    this.db.prepare("UPDATE source_auth SET account_label = ?, updated_at = ? WHERE repo = ? AND source = ?").run(accountLabel, this.now(), repo, source);
  }

  clearSourceAuth(repo: string, source: string): boolean {
    const info = this.db.prepare("DELETE FROM source_auth WHERE repo = ? AND source = ?").run(repo, source);
    return Number(info.changes) > 0;
  }

  // --- evidence-upload outbox -----------------------------------------------
  // Durable S3 media upload, mirroring the transition outbox: an intent retried at Phase 0 with backoff
  // until S3 accepts it (or a permanent config error stops it). Leaner than transitions — no
  // stale two-phase columns; permanent_failed_at is the single terminal-failure state.

  private toEvidenceUpload(r: EvidenceUploadRow): EvidenceUpload {
    return {
      id: r.id,
      runId: r.run_id,
      repo: r.repo,
      ticketKey: r.ticket_key,
      keyPrefix: r.key_prefix,
      evidenceDir: r.evidence_dir,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
      errorKind: r.error_kind as EvidenceUpload["errorKind"],
      notifiedAt: r.notified_at,
      permanentFailedAt: r.permanent_failed_at,
      abandonedAt: r.abandoned_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deliveredAt: r.delivered_at,
    };
  }

  getEvidenceUpload(id: number): EvidenceUpload | undefined {
    const row = this.db.prepare("SELECT * FROM evidence_uploads WHERE id = ?").get(id) as EvidenceUploadRow | undefined;
    return row ? this.toEvidenceUpload(row) : undefined;
  }

  /** Record the INTENT to upload one capture's media. Idempotent per (run, key_prefix): re-enqueue of
   *  the SAME prefix re-opens the row (the S3 upload is idempotent). A DIFFERENT prefix (a re-capture
   *  after a bounce) supersedes prior undelivered rows for the run — only the latest handoff's URLs are
   *  ever embedded, so retrying an older capture's bytes forever is waste. Sets the enqueue lease. */
  enqueueEvidenceUpload(input: { runId: number; repo: string; ticketKey: string; keyPrefix: string; evidenceDir: string }): EvidenceUpload {
    const t = this.now();
    return tx(this.db, () => {
      // Supersede prior undelivered captures for this run (different prefix).
      this.db
        .prepare(
          `UPDATE evidence_uploads SET abandoned_at = ?, last_error = 'superseded by re-capture', updated_at = ?
           WHERE run_id = ? AND key_prefix <> ? AND ${EVIDENCE_PENDING_SQL}`,
        )
        .run(t, t, input.runId, input.keyPrefix);
      this.db
        .prepare(
          `INSERT INTO evidence_uploads (run_id, repo, ticket_key, key_prefix, evidence_dir, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(run_id, key_prefix) DO UPDATE SET evidence_dir = excluded.evidence_dir, next_attempt_at = excluded.next_attempt_at,
             delivered_at = NULL, permanent_failed_at = NULL, abandoned_at = NULL, updated_at = excluded.updated_at`,
        )
        .run(input.runId, input.repo, input.ticketKey, input.keyPrefix, input.evidenceDir, t + EVIDENCE_UPLOAD_LEASE_SECONDS, t, t);
      const row = this.db
        .prepare("SELECT * FROM evidence_uploads WHERE run_id = ? AND key_prefix = ?")
        .get(input.runId, input.keyPrefix) as EvidenceUploadRow | undefined;
      if (!row) throw new Error("enqueueEvidenceUpload: row vanished after upsert");
      telemetryEvent("store.evidence_upload.enqueue", { repo: input.repo, "run.id": input.runId, "work.key": input.ticketKey });
      return this.toEvidenceUpload(row);
    });
  }

  /** Undelivered uploads due for a retry attempt (repo-scoped, ordered like the transition outbox). */
  dueEvidenceUploads(repo: string, limit = 25): EvidenceUpload[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM evidence_uploads WHERE repo = ? AND ${EVIDENCE_PENDING_SQL}
         AND next_attempt_at <= ? ORDER BY run_id, id LIMIT ?`,
      )
      .all(repo, this.now(), limit) as unknown as EvidenceUploadRow[];
    return rows.map((r) => this.toEvidenceUpload(r));
  }

  /** Record a failed upload attempt: bump the counter, stamp the classified kind, push next_attempt_at
   *  out (60s doubling, cap 1h). Guarded so a late failure can't reopen a row the other process (CLI vs
   *  flush) already delivered/permanent-failed. */
  recordEvidenceAttempt(id: number, error: string, kind: EvidenceUpload["errorKind"]): EvidenceUpload | undefined {
    const t = this.now();
    const current = this.getEvidenceUpload(id);
    const attempts = (current?.attempts ?? 0) + 1;
    const delay = backoffDelaySeconds(attempts, OUTBOX_BACKOFF_CAP_SECONDS);
    this.db
      .prepare(
        `UPDATE evidence_uploads SET attempts = ?, next_attempt_at = ?, last_error = ?, error_kind = ?, updated_at = ?
         WHERE id = ? AND delivered_at IS NULL AND permanent_failed_at IS NULL`,
      )
      .run(attempts, t + delay, error.slice(0, 500), kind, t, id);
    telemetryEvent("store.evidence_upload.attempt_failed", { "evidence_upload.attempts": attempts, "evidence_upload.kind": kind ?? undefined });
    return this.getEvidenceUpload(id);
  }

  markEvidenceDelivered(id: number): void {
    const t = this.now();
    this.db.prepare("UPDATE evidence_uploads SET delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_at IS NULL").run(t, t, id);
    const e = this.getEvidenceUpload(id);
    telemetryEvent("store.evidence_upload.delivered", { repo: e?.repo, "run.id": e?.runId, "work.key": e?.ticketKey });
  }

  markEvidencePermanentFailed(id: number, reason: string): void {
    const t = this.now();
    this.db
      .prepare("UPDATE evidence_uploads SET permanent_failed_at = ?, last_error = ?, error_kind = 'permanent', updated_at = ? WHERE id = ? AND delivered_at IS NULL")
      .run(t, reason.slice(0, 500), t, id);
    const e = this.getEvidenceUpload(id);
    telemetryEvent("store.evidence_upload.permanent_failed", { repo: e?.repo, "run.id": e?.runId, "work.key": e?.ticketKey });
  }

  /** Stamp the notify throttle (SSO/permanent human alert already sent). */
  markEvidenceNotified(id: number): void {
    const t = this.now();
    this.db.prepare("UPDATE evidence_uploads SET notified_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
  }

  /** Undelivered uploads for a run — teardown's drop input. */
  undeliveredEvidenceUploadsForRun(runId: number): EvidenceUpload[] {
    const rows = this.db
      .prepare(`SELECT * FROM evidence_uploads WHERE run_id = ? AND ${EVIDENCE_PENDING_SQL} ORDER BY id`)
      .all(runId) as unknown as EvidenceUploadRow[];
    return rows.map((r) => this.toEvidenceUpload(r));
  }

  /** Best-effort drop at teardown: abandon any still-pending uploads (the worktree + evidence dir are
   *  about to be removed). Returns how many were dropped so the caller can log the loss. */
  abandonEvidenceUploadsForRun(runId: number, reason: string): number {
    const t = this.now();
    const info = this.db
      .prepare(
        `UPDATE evidence_uploads SET abandoned_at = ?, last_error = ?, updated_at = ?
         WHERE run_id = ? AND ${EVIDENCE_PENDING_SQL}`,
      )
      .run(t, reason.slice(0, 500), t, runId);
    return Number(info.changes);
  }

  /** All undelivered (still-retrying) uploads for a repo — the doctor snapshot (regardless of whether
   *  each is currently due). */
  pendingEvidenceUploads(repo: string): EvidenceUpload[] {
    const rows = this.db
      .prepare(`SELECT * FROM evidence_uploads WHERE repo = ? AND ${EVIDENCE_PENDING_SQL} ORDER BY id`)
      .all(repo) as unknown as EvidenceUploadRow[];
    return rows.map((r) => this.toEvidenceUpload(r));
  }

  /** Is an evidence upload currently stuck on an AUTH failure (expired SSO)? Drives the dashboard SSO
   *  light (red) and the doctor stuck-upload check. */
  authStuckEvidenceUpload(repo: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM evidence_uploads WHERE repo = ? AND error_kind = 'auth' AND ${EVIDENCE_PENDING_SQL} LIMIT 1`)
      .get(repo) as { x: number } | undefined;
    return row !== undefined;
  }

  /** On AWS-creds RECOVERY (SSO re-login): make every auth-stuck upload due now, so the next Phase 0
   *  flush lands it instead of waiting out the (up-to-1h) backoff it accrued while creds were expired.
   *  Mirrors retryTransitionsForSource. Scoped to error_kind='auth' — transient/permanent rows keep
   *  their own retry policy (a flaky-S3 backoff or a config error creds recovery can't fix). Returns
   *  how many rows were re-queued. */
  retryEvidenceUploadsForRepo(repo: string): number {
    const t = this.now();
    const info = this.db
      .prepare(
        `UPDATE evidence_uploads SET next_attempt_at = ?, updated_at = ?
         WHERE repo = ? AND error_kind = 'auth' AND ${EVIDENCE_PENDING_SQL}`,
      )
      .run(t, t, repo);
    const requeued = Number(info.changes);
    if (requeued > 0) telemetryEvent("store.evidence_upload.creds_recovered", { repo, "evidence_upload.requeued": requeued });
    return requeued;
  }

  // --- pending agent signals (durable bounce/ask-human intents) -------------
  // The transition-outbox pattern applied to the non-monotonic agent signals: the intent is
  // persisted BEFORE the run lock is attempted, so a signal whose immediate apply loses the lock
  // race (or crashes mid-apply) is consumed by a later reconcile pass instead of being dropped
  // after the agent was already told to stop.
  //
  // STORAGE: the intent LEDGER since v31 (kind `agent_signal` — status 'waiting' + a 'signal'
  // handoff stamped atomically at enqueue; single-slot via latest-wins supersession). These
  // methods are the domain API the signal machinery keeps using — they adapt to/from the ledger
  // row, so signals.ts / consumePendingSignal never changed shape. The legacy `pending_signals`
  // table is drained LAZILY for one release: a row a still-draining old-code process enqueues
  // around the upgrade is converted to a ledger row on its first read (see below), then closed.

  /** Map a ledger `agent_signal` row back onto the domain PendingSignal shape. */
  private intentToPendingSignal(i: Intent): PendingSignal {
    const p = JSON.parse(i.payload) as { signal: PendingSignal["signal"]; step: string | null; toStep: string | null; body: string; pass: number | null };
    return {
      id: i.id,
      runId: i.runId!,
      repo: i.repo,
      ticketKey: i.ticketKey ?? "",
      signal: p.signal,
      step: p.step,
      toStep: p.toStep,
      payload: p.body,
      pass: p.pass,
      createdAt: i.createdAt,
      consumedAt: i.consumedAt,
      // A superseded row's null result reads as "superseded" (the legacy vocabulary).
      consumedResult: i.consumedResult ?? (i.status === "superseded" ? "superseded" : null),
    };
  }

  getPendingSignal(id: number): PendingSignal | undefined {
    const i = this.getIntent(id);
    return i && i.kind === "agent_signal" ? this.intentToPendingSignal(i) : undefined;
  }

  unconsumedPendingSignalForRun(runId: number): PendingSignal | undefined {
    // Lazy drain: a legacy pending_signals row (written by a draining old-code process around the
    // upgrade) is converted to a ledger row on first read, then closed — so there is exactly one
    // id space past this point. Kept one release; the v31 migration converted the backlog.
    const legacy = this.db
      .prepare("SELECT * FROM pending_signals WHERE run_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(runId) as PendingSignalRow | undefined;
    if (legacy) {
      const l = toPendingSignal(legacy);
      this.db
        .prepare("UPDATE pending_signals SET consumed_at = ?, consumed_result = 'superseded: migrated to the intent ledger' WHERE run_id = ? AND consumed_at IS NULL")
        .run(this.now(), runId);
      return this.enqueuePendingSignal({ runId: l.runId, repo: l.repo, ticketKey: l.ticketKey, signal: l.signal, step: l.step, toStep: l.toStep, payload: l.payload, pass: l.pass });
    }
    // status IN (waiting, pending): 'waiting' is the normal shape; 'pending' covers a
    // kernel-backstopped row (mis-created without the atomic handoff) so it is still consumable.
    const row = this.db
      .prepare("SELECT * FROM intents WHERE run_id = ? AND kind = 'agent_signal' AND status IN ('waiting','pending') AND consumed_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(runId) as IntentRow | undefined;
    return row ? this.intentToPendingSignal(toIntent(row)) : undefined;
  }

  /** Persist a bounce/ask-human intent. At most one unconsumed intent per run: an earlier
   *  unconsumed one is superseded (newest wins — an agent re-deciding replaces its prior signal),
   *  keeping its row + result for the timeline. Ledger-backed: status 'waiting' (the kernel never
   *  retries it — the run-locked consume owns it) with the 'signal' handoff stamped atomically. */
  enqueuePendingSignal(input: {
    runId: number;
    repo: string;
    ticketKey: string;
    signal: PendingSignal["signal"];
    step?: string | null;
    toStep?: string | null;
    payload: string;
    pass?: number | null;
  }): PendingSignal {
    const intent = this.enqueueIntent({
      repo: input.repo,
      kind: "agent_signal",
      scope: `run:${input.runId}`,
      runId: input.runId,
      ticketKey: input.ticketKey,
      // Unique per enqueue (single-slot semantics come from the supersession, not the key); the
      // pid keeps two processes' same-second enqueues distinct.
      dedupKey: `sig-${process.pid}-${++signalSeq}`,
      payload: JSON.stringify({ signal: input.signal, step: input.step ?? null, toStep: input.toStep ?? null, body: input.payload, pass: input.pass ?? null }),
      status: "waiting",
      handoff: "signal",
      supersedeScope: true,
    });
    telemetryEvent("store.pending_signal.enqueue", { repo: input.repo, "run.id": input.runId, "signal.id": intent.id, signal: input.signal, "work.key": input.ticketKey, step: input.step ?? undefined });
    return this.intentToPendingSignal(intent);
  }

  /** Stamp an intent consumed with its outcome: applied | escalated | rejected: <why>. Closes the
   *  ledger row (its scheduling obligation ended with the consume). */
  markPendingSignalConsumed(id: number, result: string): void {
    const t = this.now();
    this.db.prepare("UPDATE intents SET status = 'delivered', resolved_at = ?, updated_at = ? WHERE id = ? AND status IN ('waiting','pending')").run(t, t, id);
    this.markIntentConsumed(id, result);
    telemetryEvent("store.pending_signal.consumed", { "signal.id": id, result });
  }

  // --- the intent ledger (`intents`, v29) -------------------------------------
  // The shared deliver-lane substrate the INTENT_KINDS registry rides on. These methods carry the
  // SHARED mechanics only (idempotent enqueue with FIFO-slot-preserving re-open, latest-wins
  // supersession, due/lease queries, terminal stamps, the two-phase handoff, cause-scoped
  // requeues); everything kind-specific stays in the kind's own code, dispatched by core/ledger.ts.

  getIntent(id: number): Intent | undefined {
    const row = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as IntentRow | undefined;
    return row ? toIntent(row) : undefined;
  }

  /** Record (or re-open) an intent. Idempotent per (kind, scope, dedupKey): re-enqueueing a live
   *  row makes it due now with the fresh payload; re-enqueueing a RESOLVED one re-opens it (the
   *  delivery must be idempotent at the backend — the transition/evidence re-open precedent),
   *  keeping its original `seq` so a re-opened row holds its FIFO slot. `supersedeScope` (the
   *  latest-wins orderings) first supersedes every other live row in (kind, scope) — newest wins,
   *  superseded rows keep their outcome for the timeline. `handoff` stamps the handoff marker
   *  ATOMICALLY with the enqueue — a pure-handoff kind (agent_signal) has no crash window between
   *  "recorded" and "owed to the run". Transactional. */
  enqueueIntent(input: {
    repo: string;
    kind: string;
    scope: string;
    runId?: number | null;
    ticketKey?: string | null;
    dedupKey?: string;
    payload?: string;
    state?: string;
    status?: "pending" | "waiting";
    causeScope?: string | null;
    deadlineAt?: number | null;
    leaseUntil?: number | null;
    supersedeScope?: boolean;
    handoff?: string;
  }): Intent {
    const t = this.now();
    const dedup = input.dedupKey ?? "";
    const status = input.status ?? "pending";
    return tx(this.db, () => {
      if (input.supersedeScope) {
        this.db
          .prepare(
            `UPDATE intents SET status = 'superseded', resolved_at = ?, updated_at = ?
             WHERE kind = ? AND scope = ? AND dedup_key <> ? AND status IN ('pending','waiting')`,
          )
          .run(t, t, input.kind, input.scope, dedup);
      }
      this.db
        .prepare(
          `INSERT INTO intents (repo, kind, scope, run_id, ticket_key, dedup_key, payload, state, status, next_attempt_at,
             cause_scope, deadline_at, lease_until, handoff_at, handoff_marker, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(kind, scope, dedup_key) DO UPDATE SET
             payload = excluded.payload, state = excluded.state, status = excluded.status, next_attempt_at = excluded.next_attempt_at,
             cause_scope = excluded.cause_scope, deadline_at = excluded.deadline_at, lease_until = excluded.lease_until,
             error_class = NULL, handoff_at = excluded.handoff_at, handoff_marker = excluded.handoff_marker,
             consumed_at = NULL, consumed_result = NULL,
             resolved_at = NULL, updated_at = excluded.updated_at`,
        )
        .run(
          input.repo,
          input.kind,
          input.scope,
          input.runId ?? null,
          input.ticketKey ?? null,
          dedup,
          input.payload ?? "{}",
          input.state ?? "{}",
          status,
          t,
          input.causeScope ?? null,
          input.deadlineAt ?? null,
          input.leaseUntil ?? null,
          input.handoff != null ? t : null,
          input.handoff ?? null,
          t,
          t,
        );
      // Stamp the FIFO slot on first insert (seq = id); a re-opened row keeps its original seq.
      this.db.prepare("UPDATE intents SET seq = id WHERE kind = ? AND scope = ? AND dedup_key = ? AND seq = 0").run(input.kind, input.scope, dedup);
      const row = this.db
        .prepare("SELECT * FROM intents WHERE kind = ? AND scope = ? AND dedup_key = ?")
        .get(input.kind, input.scope, dedup) as IntentRow | undefined;
      if (!row) throw new Error("enqueueIntent: row vanished after upsert");
      telemetryEvent("store.intent.enqueue", { repo: input.repo, "intent.kind": input.kind, "intent.scope": input.scope, "intent.id": row.id, "intent.status": status });
      return toIntent(row);
    });
  }

  /** Pending intents due for a delivery attempt: due-now, not leased by an inline attempt, and not
   *  sitting on an unconsumed handoff (such a row is in the RUN's court — re-delivering before the
   *  run-locked consume would double-stamp it). Ordered (scope, seq) so a scope's FIFO chain is
   *  walked in intent order. */
  dueIntents(repo: string, limit = 25): Intent[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM intents WHERE repo = ? AND status = 'pending' AND next_attempt_at <= ?
         AND (lease_until IS NULL OR lease_until <= ?)
         AND (handoff_at IS NULL OR consumed_at IS NOT NULL) ORDER BY scope, seq LIMIT ?`,
      )
      .all(repo, now, now, limit) as unknown as IntentRow[];
    return rows.map(toIntent);
  }

  /** Is an EARLIER live intent of this kind still unresolved in the scope? The FIFO gate — checked
   *  against the DB, not the pass, so an earlier sibling that is backed off (not due) still blocks. */
  earlierPendingIntentInScope(kind: string, scope: string, seq: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM intents WHERE kind = ? AND scope = ? AND seq < ? AND status IN ('pending','waiting') LIMIT 1")
      .get(kind, scope, seq) as { x: number } | undefined;
    return row !== undefined;
  }

  /** Waiting rows whose deadline has passed and whose handoff hasn't fired — the kernel escalates
   *  these (status → failed + a 'deadline' handoff for the run-locked reaction). */
  dueIntentDeadlines(repo: string): Intent[] {
    const rows = this.db
      .prepare("SELECT * FROM intents WHERE repo = ? AND status = 'waiting' AND deadline_at IS NOT NULL AND deadline_at <= ? AND handoff_at IS NULL")
      .all(repo, this.now()) as unknown as IntentRow[];
    return rows.map(toIntent);
  }

  /** Record a failed delivery attempt: bump, classify, back off by `delaySeconds` (the kind's
   *  curve), clear any lease. Guarded to live rows so a raced terminal stamp isn't reopened
   *  ('waiting' included for engine-scheduled rows whose probes run outside the kernel — the
   *  human reply poll). */
  recordIntentAttempt(id: number, error: string, errorClass: Intent["errorClass"], delaySeconds: number): Intent | undefined {
    const t = this.now();
    this.db
      .prepare(
        `UPDATE intents SET attempts = attempts + 1, next_attempt_at = ?, lease_until = NULL,
         last_error = ?, error_class = ?, updated_at = ? WHERE id = ? AND status IN ('pending','waiting')`,
      )
      .run(t + delaySeconds, error.slice(0, 500), errorClass, t, id);
    const e = this.getIntent(id);
    telemetryEvent("store.intent.attempt_failed", { repo: e?.repo, "intent.kind": e?.kind, "intent.id": id, "intent.attempts": e?.attempts, "intent.error_class": errorClass ?? undefined });
    return e;
  }

  /** Reschedule a live row without counting an error (a reply-poll miss): due again in
   *  `delaySeconds`, kind-owned `state` optionally replaced. `resetAttempts` also zeroes the
   *  consecutive-error count — a successful probe that found nothing ends an error run. */
  rescheduleIntent(id: number, delaySeconds: number, state?: string, opts: { resetAttempts?: boolean } = {}): void {
    const t = this.now();
    const sets: string[] = ["next_attempt_at = ?", "lease_until = NULL", "updated_at = ?"];
    const vals: Bind[] = [t + delaySeconds, t];
    if (state !== undefined) {
      sets.push("state = ?");
      vals.push(state);
    }
    if (opts.resetAttempts) sets.push("attempts = 0", "error_class = NULL");
    this.db.prepare(`UPDATE intents SET ${sets.join(", ")} WHERE id = ? AND status IN ('pending','waiting')`).run(...vals, id);
  }

  /** One row by its identity key (the UNIQUE(kind, scope, dedup_key) handle). */
  intentByKey(kind: string, scope: string, dedupKey: string): Intent | undefined {
    const row = this.db.prepare("SELECT * FROM intents WHERE kind = ? AND scope = ? AND dedup_key = ?").get(kind, scope, dedupKey) as IntentRow | undefined;
    return row ? toIntent(row) : undefined;
  }

  /** Replace a row's kind-owned mutable state (poll counters, fulfil results). */
  setIntentState(id: number, state: string): void {
    this.db.prepare("UPDATE intents SET state = ?, updated_at = ? WHERE id = ?").run(state, this.now(), id);
  }

  markIntentDelivered(id: number): void {
    const t = this.now();
    this.db
      .prepare("UPDATE intents SET status = 'delivered', resolved_at = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','waiting')")
      .run(t, t, id);
    const e = this.getIntent(id);
    telemetryEvent("store.intent.delivered", { repo: e?.repo, "intent.kind": e?.kind, "intent.id": id });
  }

  markIntentFailed(id: number, reason: string): void {
    const t = this.now();
    this.db
      .prepare(
        `UPDATE intents SET status = 'failed', last_error = ?, error_class = COALESCE(error_class, 'permanent'),
         resolved_at = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','waiting')`,
      )
      .run(reason.slice(0, 500), t, t, id);
    const e = this.getIntent(id);
    telemetryEvent("store.intent.failed", { repo: e?.repo, "intent.kind": e?.kind, "intent.id": id });
  }

  /** Stamp a handoff — "a run-policy reaction is owed" — from the LOCK-FREE kernel; the run-locked
   *  Phase A consumes it exactly once. `resolve` also closes the row (the stale pattern: delivered
   *  as far as the kernel is concerned, owed to the run). A run-less (repo-scoped) handoff has no
   *  consumer loop, so it is stamped consumed immediately. */
  markIntentHandoff(id: number, marker: string, opts: { resolve?: "delivered" | "failed"; error?: string } = {}): void {
    const t = this.now();
    const sets: string[] = ["handoff_at = ?", "handoff_marker = ?", "updated_at = ?"];
    const vals: Bind[] = [t, marker, t];
    if (opts.resolve) {
      sets.push("status = ?", "resolved_at = ?", "lease_until = NULL");
      vals.push(opts.resolve, t);
    }
    if (opts.error) {
      sets.push("last_error = ?");
      vals.push(opts.error.slice(0, 500));
    }
    this.db.prepare(`UPDATE intents SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    const e = this.getIntent(id);
    if (e && e.runId == null) this.markIntentConsumed(id, "acknowledged (no run)");
    telemetryEvent("store.intent.handoff", { repo: e?.repo, "intent.kind": e?.kind, "intent.id": id, "intent.handoff": marker });
  }

  /** Unconsumed handoffs owed to a run — Phase A's consume input, oldest first. A superseded row's
   *  handoff dies with it (a newer decision replaced it; consuming both would double-apply). */
  unconsumedIntentHandoffsForRun(runId: number): Intent[] {
    const rows = this.db
      .prepare("SELECT * FROM intents WHERE run_id = ? AND handoff_at IS NOT NULL AND consumed_at IS NULL AND status <> 'superseded' ORDER BY id")
      .all(runId) as unknown as IntentRow[];
    return rows.map(toIntent);
  }

  markIntentConsumed(id: number, result: string): void {
    this.db.prepare("UPDATE intents SET consumed_at = ?, consumed_result = ?, updated_at = ? WHERE id = ?").run(this.now(), result, this.now(), id);
    telemetryEvent("store.intent.consumed", { "intent.id": id, result });
  }

  /** Resolve a `waiting` external-trigger row: the external thing happened. Stores the caller's
   *  result in `state`, closes the row, and stamps the 'fulfilled' handoff for the run-locked
   *  reaction. Returns the row, or undefined when it wasn't waiting (already fulfilled/expired). */
  fulfilIntent(id: number, result?: string): Intent | undefined {
    const t = this.now();
    const info = this.db
      .prepare("UPDATE intents SET status = 'delivered', state = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'")
      .run(result ?? "{}", t, t, id);
    if (Number(info.changes) === 0) return undefined;
    this.markIntentHandoff(id, "fulfilled");
    const e = this.getIntent(id);
    telemetryEvent("store.intent.fulfilled", { repo: e?.repo, "intent.kind": e?.kind, "intent.id": id });
    return e;
  }

  /** Stamp the per-row operator-notify throttle. */
  markIntentNotified(id: number): void {
    this.db.prepare("UPDATE intents SET notified_at = ?, updated_at = ? WHERE id = ?").run(this.now(), this.now(), id);
  }

  /** Cause recovery (auth restored, creds back): make every live row under the cause due now, so
   *  the next flush lands it instead of waiting out its backoff. Optionally scoped to an error
   *  class (the SSO path requeues auth-stuck rows only). Returns how many were re-queued. */
  requeueIntentsByCause(repo: string, causeScope: string, errorClass?: Intent["errorClass"]): number {
    const t = this.now();
    const info = errorClass
      ? this.db
          .prepare("UPDATE intents SET next_attempt_at = ?, updated_at = ? WHERE repo = ? AND cause_scope = ? AND error_class = ? AND status = 'pending'")
          .run(t, t, repo, causeScope, errorClass)
      : this.db
          .prepare("UPDATE intents SET next_attempt_at = ?, updated_at = ? WHERE repo = ? AND cause_scope = ? AND status = 'pending'")
          .run(t, t, repo, causeScope);
    const requeued = Number(info.changes);
    if (requeued > 0) telemetryEvent("store.intent.cause_recovered", { repo, "intent.cause": causeScope, "intent.requeued": requeued });
    return requeued;
  }

  /** Is any pending intent of `kind` stuck on an AUTH failure? Gates cause-recovery probes (the
   *  happy path never probes) and drives the dashboard SSO light. */
  authStuckIntents(repo: string, kind: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM intents WHERE repo = ? AND kind = ? AND status = 'pending' AND error_class = 'auth' LIMIT 1")
      .get(repo, kind) as { x: number } | undefined;
    return row !== undefined;
  }

  /** Operator due-now for one pending row (the /intents/:id/retry endpoint). */
  retryIntentNow(id: number): boolean {
    const info = this.db.prepare("UPDATE intents SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(this.now(), this.now(), id);
    return Number(info.changes) > 0;
  }

  /** Drop a run's live intents at teardown (optionally only some kinds — e.g. evidence bytes die
   *  with the worktree, while terminal write-backs must outlive the run). Returns the count. */
  abandonIntentsForRun(runId: number, reason: string, kinds?: readonly string[]): number {
    const t = this.now();
    const kindFilter = kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const info = this.db
      .prepare(
        `UPDATE intents SET status = 'abandoned', last_error = ?, resolved_at = ?, updated_at = ?
         WHERE run_id = ? AND status IN ('pending','waiting')${kindFilter}`,
      )
      .run(reason.slice(0, 500), t, t, runId, ...(kinds ?? []));
    return Number(info.changes);
  }

  /** Ledger rows for the introspection surfaces (the /intents endpoint, obligations, doctor). */
  listIntents(repo: string, filter: { kind?: string; status?: IntentStatus; runId?: number; key?: string; limit?: number } = {}): Intent[] {
    const where: string[] = ["repo = ?"];
    const vals: Bind[] = [repo];
    if (filter.kind) {
      where.push("kind = ?");
      vals.push(filter.kind);
    }
    if (filter.status) {
      where.push("status = ?");
      vals.push(filter.status);
    }
    if (filter.runId != null) {
      where.push("run_id = ?");
      vals.push(filter.runId);
    }
    if (filter.key) {
      where.push("ticket_key = ?");
      vals.push(filter.key);
    }
    const rows = this.db
      .prepare(`SELECT * FROM intents WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...vals, filter.limit ?? 100) as unknown as IntentRow[];
    return rows.map(toIntent);
  }

  // --- human-in-the-loop questions ------------------------------------------
  // The DOMAIN rows (question / answer / external ids / status) live in human_questions; the
  // question's SCHEDULING — the reply-poll clock, miss backoff, and consecutive-error escalation —
  // lives on the intent ledger since v32 (kind `human_reply_poll`, one `waiting` row per pending
  // question, keyed q-<id>): attempts = consecutive poll ERRORS (reset by any successful poll),
  // state.pollAttempts = misses (drives the base backoff exponent), next_attempt_at = the poll
  // gate. The methods below OVERLAY the ledger clock onto the domain shape, so the reply loop in
  // reconcileWaitingForHuman is unchanged. The legacy poll columns are frozen (unread); a pending
  // question with no ledger row (written by a draining old-code process) gets one lazily. Polling
  // itself stays under the run lock — moving it onto the kernel's lock-free walk is a possible
  // follow-up, deliberately not taken with the storage cutover.

  /** The question's ledger scheduling row (its poll clock), creating it lazily for a pending
   *  question that predates the ledger (the old-code drain window). */
  private humanPollIntent(q: { id: number; runId: number; repo: string; ticketKey: string; status: string }, createIfMissing = true): Intent | undefined {
    const existing = this.intentByKey("human_reply_poll", `run:${q.runId}`, `q-${q.id}`);
    if (existing || !createIfMissing || q.status !== "pending") return existing;
    return this.enqueueIntent({
      repo: q.repo,
      kind: "human_reply_poll",
      scope: `run:${q.runId}`,
      runId: q.runId,
      ticketKey: q.ticketKey,
      dedupKey: `q-${q.id}`,
      payload: JSON.stringify({ questionId: q.id }),
      state: JSON.stringify({ pollAttempts: 0 }),
      status: "waiting", // engine-scheduled: the run-locked reply loop drives it, never the kernel
    });
  }

  /** Overlay the ledger clock onto the domain row (the shape every caller keeps reading). */
  private withPollClock(row: HumanQuestionRow): HumanQuestion {
    const q = toHumanQuestion(row);
    const intent = this.humanPollIntent(q, q.status === "pending");
    if (!intent) return q; // answered pre-ledger: the frozen legacy columns are as good as any
    let pollAttempts = 0;
    try {
      pollAttempts = (JSON.parse(intent.state) as { pollAttempts?: number }).pollAttempts ?? 0;
    } catch {
      /* state is engine-written; tolerate anything */
    }
    // A resolved row's error run is OVER (the answering poll succeeded — the legacy contract
    // zeroed poll_errors on answer); only a live row's consecutive-error count is reportable.
    const live = intent.status === "waiting" || intent.status === "pending";
    return { ...q, pollAttempts, pollErrors: live ? intent.attempts : 0, nextPollAt: intent.nextAttemptAt };
  }

  getHumanQuestion(id: number): HumanQuestion | undefined {
    const row = this.db.prepare("SELECT * FROM human_questions WHERE id = ?").get(id) as HumanQuestionRow | undefined;
    return row ? this.withPollClock(row) : undefined;
  }

  pendingHumanQuestionForRun(runId: number): HumanQuestion | undefined {
    const row = this.db
      .prepare("SELECT * FROM human_questions WHERE run_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .get(runId) as HumanQuestionRow | undefined;
    return row ? this.withPollClock(row) : undefined;
  }

  createHumanQuestion(input: {
    runId: number;
    repo: string;
    workSource: string;
    ticketKey: string;
    step?: string | null;
    question: string;
  }): HumanQuestion {
    const existing = this.pendingHumanQuestionForRun(input.runId);
    if (existing) return existing;
    const t = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO human_questions (run_id, repo, work_source, ticket_key, step, question, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(input.runId, input.repo, input.workSource, input.ticketKey, input.step ?? null, input.question, t, t);
    const q = this.getHumanQuestion(Number(info.lastInsertRowid)); // getHumanQuestion arms the poll row
    if (!q) throw new Error("createHumanQuestion: row vanished after insert");
    telemetryEvent("store.human_question.create", { repo: q.repo, "run.id": q.runId, "question.id": q.id, "work.key": q.ticketKey, step: q.step ?? undefined });
    return q;
  }

  updateHumanQuestion(id: number, patch: HumanQuestionPatch): void {
    const sets: string[] = [];
    const vals: Bind[] = [];
    const set = (col: string, v: Bind) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.externalId !== undefined) set("external_id", patch.externalId);
    if (patch.externalCreatedAt !== undefined) set("external_created_at", patch.externalCreatedAt);
    if (patch.answer !== undefined) set("answer", patch.answer);
    if (patch.answerExternalId !== undefined) set("answer_external_id", patch.answerExternalId);
    if (patch.answerAuthor !== undefined) set("answer_author", patch.answerAuthor);
    if (patch.answeredAt !== undefined) set("answered_at", patch.answeredAt);
    if (sets.length === 0) return;
    set("updated_at", this.now());
    this.db.prepare(`UPDATE human_questions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    // A question leaving `pending` (answered, or superseded-as-answered by a newer ask) ends its
    // poll obligation — close the ledger row so the clock can't outlive the question.
    if (patch.status === "answered") {
      const q = this.db.prepare("SELECT * FROM human_questions WHERE id = ?").get(id) as HumanQuestionRow | undefined;
      if (q) {
        const intent = this.intentByKey("human_reply_poll", `run:${q.run_id}`, `q-${id}`);
        if (intent && (intent.status === "waiting" || intent.status === "pending")) {
          this.db
            .prepare("UPDATE intents SET status = 'delivered', resolved_at = ?, updated_at = ? WHERE id = ?")
            .run(this.now(), this.now(), intent.id);
        }
      }
    }
    const q = this.getHumanQuestion(id);
    telemetryEvent("store.human_question.update", {
      repo: q?.repo,
      "run.id": q?.runId,
      "question.id": id,
      "question.status": q?.status,
      "patch.fields": patchFields(patch),
    });
  }

  /** Record a poll that found no reply: back the next poll off (60s doubling, capped at 5min).
   *  Human replies take minutes-to-hours; per-tick polling of every waiting run was pure
   *  source-API load for no latency benefit. */
  recordHumanPollMiss(id: number): HumanQuestion {
    const q = this.getHumanQuestion(id);
    if (!q) throw new Error(`recordHumanPollMiss: no question ${id}`);
    const intent = this.humanPollIntent(q)!;
    const attempts = q.pollAttempts + 1;
    const delay = backoffDelaySeconds(attempts, HUMAN_POLL_BACKOFF_CAP_SECONDS);
    // A miss is a SUCCESSFUL poll that found no reply — it also resets the consecutive-error run.
    this.rescheduleIntent(intent.id, delay, JSON.stringify({ pollAttempts: attempts }), { resetAttempts: true });
    return this.getHumanQuestion(id)!;
  }

  /** Fresh polling window for a resumed run: due now, error run cleared (a resume must get a
   *  full escalation window, not instantly re-trip the consecutive-error cap). */
  resetHumanPollBackoff(id: number): void {
    const q = this.getHumanQuestion(id);
    if (!q) return;
    const intent = this.humanPollIntent(q);
    if (intent) this.rescheduleIntent(intent.id, 0, JSON.stringify({ pollAttempts: 0 }), { resetAttempts: true });
  }

  /** Record a pollHumanReply THROW: same backoff as a miss, but counted separately so a
   *  persistently-failing source escalates (a slow human never should). */
  recordHumanPollError(id: number): HumanQuestion {
    const q = this.getHumanQuestion(id);
    if (!q) throw new Error(`recordHumanPollError: no question ${id}`);
    const intent = this.humanPollIntent(q)!;
    const errors = q.pollErrors + 1;
    // The error backoff STACKS on the miss exponent (attempts + errors) so a flapping source keeps
    // thinning out even while misses reset between throws.
    const delay = backoffDelaySeconds(q.pollAttempts + errors, HUMAN_POLL_BACKOFF_CAP_SECONDS);
    this.recordIntentAttempt(intent.id, "reply poll failed", "transient", delay);
    telemetryEvent("store.human_question.poll_error", { repo: q.repo, "run.id": q.runId, "question.id": q.id, "poll.errors": errors });
    return this.getHumanQuestion(id)!;
  }

  answerHumanQuestion(
    id: number,
    reply: { body: string; externalId: string; externalCreatedAt?: string | null; author?: string | null },
  ): HumanQuestion {
    const t = this.now();
    this.updateHumanQuestion(id, {
      status: "answered",
      answer: reply.body,
      answerExternalId: reply.externalId,
      answerAuthor: reply.author ?? null,
      answeredAt: t,
    });
    const q = this.getHumanQuestion(id);
    if (!q) throw new Error("answerHumanQuestion: row vanished after update");
    telemetryEvent("store.human_question.answer", { repo: q.repo, "run.id": q.runId, "question.id": q.id, "work.key": q.ticketKey });
    return q;
  }

  // --- work_items (internal lifecycle ledger for sources with no external status; local_markdown) ---

  getWorkItem(repo: string, source: string, key: string): WorkItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE repo = ? AND source = ? AND key = ?")
      .get(repo, source, key) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : undefined;
  }

  /** All items for a source, optionally filtered by status (newest activity first). */
  listWorkItems(repo: string, source: string, status?: WorkState): WorkItem[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM work_items WHERE repo = ? AND source = ? AND status = ? ORDER BY updated_at DESC")
            .all(repo, source, status)
        : this.db
            .prepare("SELECT * FROM work_items WHERE repo = ? AND source = ? ORDER BY updated_at DESC")
            .all(repo, source)
    ) as unknown as WorkItemRow[];
    return rows.map(toWorkItem);
  }

  /**
   * Upsert an item's status (and optional metadata). Idempotent and tolerant: any state → any
   * state, never throws on a "non-adjacent" transition — work_items.status is a best-effort
   * label, not a strict state machine (the run lifecycle is the source of truth). Returns false
   * if the status was already the target (no-op), mirroring JiraClient.transition's contract.
   */
  setWorkItemStatus(
    repo: string,
    source: string,
    key: string,
    status: WorkState,
    meta: { title?: string | null; itemType?: string | null; path?: string | null; lastRelease?: string | null } = {},
  ): boolean {
    const t = this.now();
    const existing = this.getWorkItem(repo, source, key);
    if (existing && existing.status === status) {
      // Still refresh metadata if newly provided, but report no status change.
      if (meta.title !== undefined || meta.itemType !== undefined || meta.path !== undefined || meta.lastRelease !== undefined) {
        this.db
          .prepare(
            "UPDATE work_items SET title = COALESCE(?, title), item_type = COALESCE(?, item_type), path = COALESCE(?, path), last_release = COALESCE(?, last_release), updated_at = ? WHERE repo = ? AND source = ? AND key = ?",
          )
          .run(meta.title ?? null, meta.itemType ?? null, meta.path ?? null, meta.lastRelease ?? null, t, repo, source, key);
      }
      telemetryEvent("store.work_item.status_noop", { repo, "work.source": source, "work.key": key, "work.state": status });
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO work_items (repo, source, key, title, item_type, path, status, last_release, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, source, key) DO UPDATE SET
           status = excluded.status,
           title = COALESCE(excluded.title, work_items.title),
           item_type = COALESCE(excluded.item_type, work_items.item_type),
           path = COALESCE(excluded.path, work_items.path),
           last_release = COALESCE(excluded.last_release, work_items.last_release),
           updated_at = excluded.updated_at`,
      )
      .run(repo, source, key, meta.title ?? null, meta.itemType ?? null, meta.path ?? null, status, meta.lastRelease ?? null, t, t);
    telemetryEvent("store.work_item.status", { repo, "work.source": source, "work.key": key, "work.state": status });
    return true;
  }

  /** Stamp the release an item was last seen/fixed on WITHOUT touching its status (the sentry source
   *  records this at materialize time). No-op if the row doesn't exist yet or `release` is null —
   *  the ledger row is created at claim, before materialize records the release onto it. */
  setWorkItemRelease(repo: string, source: string, key: string, release: string | null): void {
    if (!release) return;
    this.db
      .prepare("UPDATE work_items SET last_release = ?, updated_at = ? WHERE repo = ? AND source = ? AND key = ?")
      .run(release, this.now(), repo, source, key);
  }
}
