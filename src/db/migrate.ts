import type { Database } from "better-sqlite3";

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
];

/** Apply pending migrations in a transaction. Idempotent. */
export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    });
    apply();
  }
}
