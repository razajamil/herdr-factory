import type Database from "better-sqlite3";
import type { Clock, EventType, Outcome, Run, RunPatch } from "../types.ts";
import { systemClock } from "../types.ts";

interface RunRow {
  id: number;
  repo: string;
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
  worker_done: number;
  attention_reason: string | null;
  outcome: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    repo: r.repo,
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
    workerDone: r.worker_done !== 0,
    attentionReason: r.attention_reason,
    outcome: r.outcome as Outcome | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

type Bind = string | number | null;

/** Typed repository over the SQLite DB. All methods are synchronous. */
export class Store {
  constructor(
    private readonly db: Database.Database,
    private readonly now: Clock = systemClock,
  ) {}

  countActive(repo: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE repo = ? AND ended_at IS NULL")
      .get(repo) as { n: number };
    return row.n;
  }

  activeRuns(repo: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND ended_at IS NULL ORDER BY created_at")
      .all(repo) as RunRow[];
    return rows.map(toRun);
  }

  activeRunForTicket(repo: string, key: string): Run | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND ticket_key = ? AND ended_at IS NULL")
      .get(repo, key) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  createRun(input: {
    repo: string;
    ticketKey: string;
    summary?: string | null;
    issueType?: string | null;
    branch?: string | null;
  }): Run {
    const t = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO runs (repo, ticket_key, summary, issue_type, branch, phase, worker_done, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'claiming', 0, ?, ?)`,
      )
      .run(input.repo, input.ticketKey, input.summary ?? null, input.issueType ?? null, input.branch ?? null, t, t);
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
    if (patch.workerDone !== undefined) set("worker_done", patch.workerDone ? 1 : 0);
    if (patch.attentionReason !== undefined) set("attention_reason", patch.attentionReason);
    if (patch.outcome !== undefined) set("outcome", patch.outcome);
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
    const run = this.db.transaction((): boolean => {
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
    return run();
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
}
