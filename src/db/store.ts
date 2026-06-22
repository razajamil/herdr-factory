import type { DatabaseSync } from "node:sqlite";
import type { Clock, EventType, Outcome, Run, RunPatch, RunStep, RunStepPatch, StepName, WorkItem, WorkState } from "../types.ts";
import { systemClock } from "../types.ts";
import { tx } from "./tx.ts";

interface RunRow {
  id: number;
  repo: string;
  work_source: string | null;
  ticket_key: string;
  summary: string | null;
  issue_type: string | null;
  branch: string | null;
  phase: string;
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
    ticketKey: r.ticket_key,
    summary: r.summary,
    issueType: r.issue_type,
    branch: r.branch,
    phase: r.phase as Run["phase"],
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

type Bind = string | number | null;

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
    ticketKey: string;
    summary?: string | null;
    issueType?: string | null;
    branch?: string | null;
  }): Run {
    const t = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO runs (repo, work_source, ticket_key, summary, issue_type, branch, phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'claiming', ?, ?)`,
      )
      .run(input.repo, input.workSource, input.ticketKey, input.summary ?? null, input.issueType ?? null, input.branch ?? null, t, t);
    const run = this.getRun(Number(info.lastInsertRowid));
    if (!run) throw new Error("createRun: row vanished after insert");
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
  }

  endRun(id: number, outcome: Outcome): void {
    const t = this.now();
    this.db
      .prepare("UPDATE runs SET phase = 'done', outcome = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(outcome, t, t, id);
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
  }

  /** TTL lock; steals an expired holder. Atomic. */
  acquireLock(name: string, owner: string, ttlSec: number): boolean {
    const now = this.now();
    return tx(this.db, (): boolean => {
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
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
  }

  upsertRepo(name: string, repoPath: string, baseRef: string | null, github: string | null): void {
    this.db
      .prepare(
        `INSERT INTO repos (name, repo_path, base_ref, github) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET repo_path = excluded.repo_path, base_ref = excluded.base_ref, github = excluded.github`,
      )
      .run(name, repoPath, baseRef, github);
  }

  touchTick(repo: string): void {
    this.db.prepare("UPDATE repos SET last_tick_at = ? WHERE name = ?").run(this.now(), repo);
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

  // --- run steps (one row per pipeline agent: fix / review / pr) --------------

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
    if (!this.getRunStep(runId, step)) {
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
    return this.getRunStep(runId, step)!;
  }

  markStepDone(runId: number, step: StepName): void {
    this.upsertRunStep(runId, step, { done: true });
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
    return true;
  }
}
