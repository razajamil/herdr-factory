import type { DatabaseSync } from "node:sqlite";
import type {
  Clock,
  EventType,
  EvidenceUpload,
  HumanQuestion,
  HumanQuestionPatch,
  Outcome,
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
  done: number;
  started_at: number | null;
  done_at: number | null;
  bounces: number;
  capture_attempts: number;
  absent_at: number | null;
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
    done: r.done !== 0,
    startedAt: r.started_at,
    doneAt: r.done_at,
    bounces: r.bounces,
    captureAttempts: r.capture_attempts,
    absentAt: r.absent_at,
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
  created_at: number;
  updated_at: number;
}

/** Enqueue lease for an evidence upload: the CLI's inline attempt runs UNLOCKED in the agent process,
 *  concurrently with the server's Phase 0 flush. Setting next_attempt_at this far out at enqueue keeps
 *  the flush from claiming the row mid inline-upload; a failed inline attempt resets it to the 60s
 *  backoff so the server picks it up promptly, and it doubles as crash-recovery if the CLI dies mid-upload. */
const EVIDENCE_UPLOAD_LEASE_SECONDS = 300;

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

type Bind = string | number | null;
const patchFields = (patch: Record<string, unknown>): string[] => Object.keys(patch).filter((k) => patch[k] !== undefined).sort();

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

  /** The machine `reason` of the run's most recent `attention` escalation (read from the event log —
   *  the run row carries only the human-readable string). Lets reconcileAttention tell a
   *  step-execution watchdog park (evidence capture cap / per-step budget / stall / layout wait —
   *  auto-rescuable by a genuine step-done) apart from a source-stale / pr-closed / bounce / human /
   *  config park, which a human must resolve. null if the run was never parked (or the reason is
   *  unrecorded). */
  lastAttentionReasonCode(runId: number): string | null {
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

  /** Insert the step row if missing, then apply the patch. Returns the fresh row. */
  upsertRunStep(runId: number, step: StepName, patch: RunStepPatch = {}): RunStep {
    const created = !this.getRunStep(runId, step);
    if (created) {
      this.db.prepare("INSERT INTO run_steps (run_id, step, started_at) VALUES (?, ?, ?)").run(runId, step, this.now());
    }
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
    if (patch.startedAt !== undefined) set("started_at", patch.startedAt);
    if (patch.captureAttempts !== undefined) set("capture_attempts", patch.captureAttempts);
    if (patch.absentAt !== undefined) set("absent_at", patch.absentAt);
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

  /** Increment (and return) the bounce count for a step — how many times a LATER step has sent the
   *  run back to it for rework. Ensures the row exists first (so it's safe to bounce to a step whose
   *  row somehow isn't materialized yet). The reconciler escalates once this exceeds limits.maxBounces. */
  bumpBounces(runId: number, step: StepName): number {
    this.upsertRunStep(runId, step); // ensure the row exists
    this.db.prepare("UPDATE run_steps SET bounces = bounces + 1 WHERE run_id = ? AND step = ?").run(runId, step);
    const row = this.getRunStep(runId, step)!;
    telemetryEvent("store.run_step.bounce", { "run.id": runId, step, "step.bounces": row.bounces });
    return row.bounces;
  }

  /** Increment (and return) the capture-attempt count for an evidence step — how many capture
   *  attempts its agent has signalled THIS pass. Ensures the row exists first. The reconciler parks
   *  the run for attention once this exceeds limits.maxCaptureAttempts. Unlike `bounces`, it is reset
   *  to 0 on each fresh entry into the step (see reconcileStep / resumeRun), so a legitimate re-pass
   *  after a fix rework gets a full budget rather than inheriting the last pass's count. */
  bumpCaptureAttempts(runId: number, step: StepName): number {
    this.upsertRunStep(runId, step); // ensure the row exists
    this.db.prepare("UPDATE run_steps SET capture_attempts = capture_attempts + 1 WHERE run_id = ? AND step = ?").run(runId, step);
    const row = this.getRunStep(runId, step)!;
    telemetryEvent("store.run_step.capture_attempt", { "run.id": runId, step, "step.capture_attempts": row.captureAttempts });
    return row.captureAttempts;
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

  /** Record the INTENT to move a work item to `toState`. Idempotent per (run, state): re-enqueueing
   *  a delivered intent re-opens it for delivery (the transition itself is idempotent at the
   *  source), re-enqueueing a pending one just makes it due now. */
  enqueueTransition(input: { runId: number; repo: string; workSource: string; ticketKey: string; toState: WorkState }): TransitionIntent {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO transition_outbox (run_id, repo, work_source, ticket_key, to_state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(run_id, to_state) DO UPDATE SET next_attempt_at = excluded.next_attempt_at, delivered_at = NULL,
           stale_at = NULL, stale_handled_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(input.runId, input.repo, input.workSource, input.ticketKey, input.toState, t, t, t);
    const row = this.db
      .prepare("SELECT * FROM transition_outbox WHERE run_id = ? AND to_state = ?")
      .get(input.runId, input.toState) as TransitionIntentRow | undefined;
    if (!row) throw new Error("enqueueTransition: row vanished after upsert");
    telemetryEvent("store.transition.enqueue", { repo: input.repo, "run.id": input.runId, "work.key": input.ticketKey, "work.state": input.toState });
    return this.toTransitionIntent(row);
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
    const delay = Math.min(60 * 2 ** (attempts - 1), 3600);
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
           WHERE run_id = ? AND key_prefix <> ? AND delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL`,
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
        `SELECT * FROM evidence_uploads WHERE repo = ? AND delivered_at IS NULL AND permanent_failed_at IS NULL
         AND abandoned_at IS NULL AND next_attempt_at <= ? ORDER BY run_id, id LIMIT ?`,
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
    const delay = Math.min(60 * 2 ** (attempts - 1), 3600);
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
      .prepare("SELECT * FROM evidence_uploads WHERE run_id = ? AND delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL ORDER BY id")
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
         WHERE run_id = ? AND delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL`,
      )
      .run(t, reason.slice(0, 500), t, runId);
    return Number(info.changes);
  }

  /** All undelivered (still-retrying) uploads for a repo — the doctor snapshot (regardless of whether
   *  each is currently due). */
  pendingEvidenceUploads(repo: string): EvidenceUpload[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence_uploads WHERE repo = ? AND delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL ORDER BY id")
      .all(repo) as unknown as EvidenceUploadRow[];
    return rows.map((r) => this.toEvidenceUpload(r));
  }

  /** Is an evidence upload currently stuck on an AUTH failure (expired SSO)? Drives the dashboard SSO
   *  light (red) and the doctor stuck-upload check. */
  authStuckEvidenceUpload(repo: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM evidence_uploads WHERE repo = ? AND error_kind = 'auth'
         AND delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL LIMIT 1`,
      )
      .get(repo) as { x: number } | undefined;
    return row !== undefined;
  }

  // --- human-in-the-loop questions ------------------------------------------

  getHumanQuestion(id: number): HumanQuestion | undefined {
    const row = this.db.prepare("SELECT * FROM human_questions WHERE id = ?").get(id) as HumanQuestionRow | undefined;
    return row ? toHumanQuestion(row) : undefined;
  }

  pendingHumanQuestionForRun(runId: number): HumanQuestion | undefined {
    const row = this.db
      .prepare("SELECT * FROM human_questions WHERE run_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .get(runId) as HumanQuestionRow | undefined;
    return row ? toHumanQuestion(row) : undefined;
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
    const q = this.getHumanQuestion(Number(info.lastInsertRowid));
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
    const attempts = q.pollAttempts + 1;
    const delay = Math.min(60 * 2 ** (attempts - 1), 300);
    const t = this.now();
    // A miss is a SUCCESSFUL poll that found no reply — it also resets the consecutive-error run.
    this.db
      .prepare("UPDATE human_questions SET poll_attempts = ?, poll_errors = 0, next_poll_at = ?, updated_at = ? WHERE id = ?")
      .run(attempts, t + delay, t, id);
    return this.getHumanQuestion(id)!;
  }

  /** Fresh polling window for a resumed run: due now, error run cleared (a resume must get a
   *  full escalation window, not instantly re-trip the consecutive-error cap). */
  resetHumanPollBackoff(id: number): void {
    const t = this.now();
    this.db.prepare("UPDATE human_questions SET poll_attempts = 0, poll_errors = 0, next_poll_at = 0, updated_at = ? WHERE id = ?").run(t, id);
  }

  /** Record a pollHumanReply THROW: same backoff as a miss, but counted separately so a
   *  persistently-failing source escalates (a slow human never should). */
  recordHumanPollError(id: number): HumanQuestion {
    const q = this.getHumanQuestion(id);
    if (!q) throw new Error(`recordHumanPollError: no question ${id}`);
    const errors = q.pollErrors + 1;
    const delay = Math.min(60 * 2 ** (q.pollAttempts + errors - 1), 300);
    const t = this.now();
    this.db
      .prepare("UPDATE human_questions SET poll_errors = ?, next_poll_at = ?, updated_at = ? WHERE id = ?")
      .run(errors, t + delay, t, id);
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
    // The answering poll succeeded — close out the consecutive-error run too.
    this.db.prepare("UPDATE human_questions SET poll_errors = 0 WHERE id = ?").run(id);
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
    meta: { title?: string | null; itemType?: string | null; path?: string | null } = {},
  ): boolean {
    const t = this.now();
    const existing = this.getWorkItem(repo, source, key);
    if (existing && existing.status === status) {
      // Still refresh metadata if newly provided, but report no status change.
      if (meta.title !== undefined || meta.itemType !== undefined || meta.path !== undefined) {
        this.db
          .prepare(
            "UPDATE work_items SET title = COALESCE(?, title), item_type = COALESCE(?, item_type), path = COALESCE(?, path), updated_at = ? WHERE repo = ? AND source = ? AND key = ?",
          )
          .run(meta.title ?? null, meta.itemType ?? null, meta.path ?? null, t, repo, source, key);
      }
      telemetryEvent("store.work_item.status_noop", { repo, "work.source": source, "work.key": key, "work.state": status });
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO work_items (repo, source, key, title, item_type, path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, source, key) DO UPDATE SET
           status = excluded.status,
           title = COALESCE(excluded.title, work_items.title),
           item_type = COALESCE(excluded.item_type, work_items.item_type),
           path = COALESCE(excluded.path, work_items.path),
           updated_at = excluded.updated_at`,
      )
      .run(repo, source, key, meta.title ?? null, meta.itemType ?? null, meta.path ?? null, status, t, t);
    telemetryEvent("store.work_item.status", { repo, "work.source": source, "work.key": key, "work.state": status });
    return true;
  }
}
