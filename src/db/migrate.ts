import type { DatabaseSync } from "node:sqlite";
import { tx } from "./tx.ts";

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE repos (
        name TEXT PRIMARY KEY, repo_path TEXT, base_ref TEXT, github TEXT,
        last_tick_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, ticket_key TEXT NOT NULL,
        summary TEXT, issue_type TEXT, branch TEXT,
        phase TEXT NOT NULL,
        workspace_id TEXT, pane_id TEXT, worktree_path TEXT, pr_number INTEGER,
        watch_deadline INTEGER, last_thread_sig TEXT,
        worker_done INTEGER NOT NULL DEFAULT 0,
        attention_reason TEXT, outcome TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE INDEX idx_runs_active ON runs(repo) WHERE ended_at IS NULL;
      CREATE INDEX idx_runs_ticket ON runs(repo, ticket_key);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES runs(id),
        repo TEXT NOT NULL, ticket_key TEXT,
        ts INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX idx_events_run ON events(run_id, ts);
      CREATE TABLE locks (
        name TEXT PRIMARY KEY, owner TEXT, acquired_at INTEGER, expires_at INTEGER
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE runs ADD COLUMN review_done INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN review_pane TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE runs ADD COLUMN progress_sig TEXT;
      ALTER TABLE runs ADD COLUMN progress_at INTEGER;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE run_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        step TEXT NOT NULL,                  -- fix | review | pr
        pane_id TEXT, session_id TEXT,       -- on-demand cross-agent query handles
        progress_sig TEXT, progress_at INTEGER,   -- per-step heartbeat
        done INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER, done_at INTEGER
      );
      CREATE INDEX idx_run_steps ON run_steps(run_id, step);
    `,
  },
  {
    version: 5,
    // "the active step changed but the user hasn't been shown it yet" — set when a step is
    // (re)spawned, cleared once the focus shift is applied (applyPendingFocus). Persisting it
    // is what lets a transition in an unfocused worktree be deferred across ticks.
    sql: `ALTER TABLE runs ADD COLUMN focus_pending INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 6,
    // Multi-source work. Every run now records WHICH configured work source it was claimed
    // from. The column is left NULLABLE (no DEFAULT) on purpose: a future run that somehow
    // lands without a source should surface loudly (resolveSource → escalate) rather than be
    // silently coerced to 'jira'. The one-time backfill stamps pre-upgrade in-flight runs as
    // 'jira' — the only source that existed before — so they keep resolving after the upgrade.
    // INVARIANT: the pre-existing Jira source MUST keep the default name 'jira' (see config.ts
    // / ARCHITECTURE §10) or backfilled in-flight runs won't match a configured source.
    // The ALTER + UPDATE + CREATE commit atomically (migrate() wraps each version in a txn).
    //
    // work_items is herdr-factory's internal status ledger for sources with no external status
    // of record (local_markdown). Jira keeps its status in Jira; this table is never touched by
    // the Jira source. `runs` remains the dedup source of truth; work_items.status is the
    // best-effort lifecycle label that gates which markdown files are eligible.
    sql: `
      ALTER TABLE runs ADD COLUMN work_source TEXT;
      UPDATE runs SET work_source = 'jira' WHERE work_source IS NULL;
      CREATE TABLE work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
        title TEXT, item_type TEXT, path TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('todo','in_development','in_review','merged','aborted')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(repo, source, key)
      );
      CREATE INDEX idx_work_items ON work_items(repo, source, status);
    `,
  },
  {
    version: 7,
    // Belts. A run now records which BELT (its ordered steps + lifecycle) is processing it, in
    // addition to its work_source, and which step is active (run.step, set while phase='running').
    // Both columns are NULLABLE: this is a clean-break redesign (see ARCHITECTURE / README) — any
    // run left in-flight across the upgrade lands with belt=NULL and is escalated to attention by
    // the reconciler rather than silently resumed onto a guessed belt. run_steps.step stays TEXT
    // (already unconstrained), so arbitrary custom step names persist with no schema change.
    //
    // work_items.status gains a sixth value 'done' — the terminal state a custom (non-PR) belt
    // writes when its last step finishes. SQLite can't ALTER a CHECK constraint, so the table is
    // rebuilt (copy → drop → rename); the whole version runs in one transaction (see migrate()).
    sql: `
      ALTER TABLE runs ADD COLUMN belt TEXT;
      ALTER TABLE runs ADD COLUMN step TEXT;
      CREATE TABLE work_items_v7 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
        title TEXT, item_type TEXT, path TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('todo','in_development','in_review','merged','aborted','done')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(repo, source, key)
      );
      INSERT INTO work_items_v7 (id, repo, source, key, title, item_type, path, status, created_at, updated_at)
        SELECT id, repo, source, key, title, item_type, path, status, created_at, updated_at FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_v7 RENAME TO work_items;
      CREATE INDEX idx_work_items ON work_items(repo, source, status);
    `,
  },
];

/** Apply pending migrations in a transaction. Idempotent. */
export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    });
  }
}
