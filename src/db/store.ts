import type { DatabaseSync } from "node:sqlite";
import type {
  Clock,
  EventType,
  HumanQuestion,
  HumanQuestionPatch,
  Outcome,
  Run,
  RunPatch,
  RunStep,
  RunStepPatch,
  StepName,
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
  watch_deadline: number | null;
  last_thread_sig: string | null;
  attention_reason: string | null;
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
    watchDeadline: r.watch_deadline,
    lastThreadSig: r.last_thread_sig,
    attentionReason: r.attention_reason,
    outcome: r.outcome as Outcome | null,
    focusPending: r.focus_pending !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

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

  activeRuns(repo: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND ended_at IS NULL ORDER BY created_at")
      .all(repo) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** The active run for a ticket WITHIN a source — the Phase-B dedup key. Scoped by source so
   *  two sources can legitimately carry the same key (e.g. a Jira ticket and a like-named .md). */
  activeRunForTicket(repo: string, source: string, key: string): Run | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND work_source = ? AND ticket_key = ? AND ended_at IS NULL")
      .get(repo, source, key) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** All active runs for a ticket key, across sources — for the manual CLI (claim/teardown/
   *  step-done) which is given only a key. The caller errors when this returns >1 (ambiguous). */
  activeRunsForKey(repo: string, key: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND ticket_key = ? AND ended_at IS NULL ORDER BY id")
      .all(repo, key) as unknown as RunRow[];
    return rows.map(toRun);
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
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
    if (patch.prNumber !== undefined) set("pr_number", patch.prNumber);
    if (patch.watchDeadline !== undefined) set("watch_deadline", patch.watchDeadline);
    if (patch.lastThreadSig !== undefined) set("last_thread_sig", patch.lastThreadSig);
    if (patch.attentionReason !== undefined) set("attention_reason", patch.attentionReason);
    if (patch.outcome !== undefined) set("outcome", patch.outcome);
    if (patch.focusPending !== undefined) set("focus_pending", patch.focusPending ? 1 : 0);
    if (sets.length === 0) return;
    set("updated_at", this.now());
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
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
