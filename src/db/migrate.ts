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
