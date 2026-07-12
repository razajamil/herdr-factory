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
  {
    version: 8,
    // Human-in-the-loop questions. These are source-agnostic: the engine records the paused run
    // and the source adapter records whatever external object represents the question (a Jira
    // comment for Jira today, Linear comment / local inbox later). One pending question per run is
    // enough for the current belt model and prevents duplicate comments when an agent retries the
    // ask command or the dispatcher retries a failed post.
    sql: `
      CREATE TABLE human_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        work_source TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        step TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','answered')),
        external_id TEXT,
        external_created_at TEXT,
        answer TEXT,
        answer_external_id TEXT,
        answer_author TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX idx_human_questions_pending ON human_questions(repo, status);
      CREATE INDEX idx_human_questions_run ON human_questions(run_id, status);
      CREATE UNIQUE INDEX idx_human_questions_one_pending_run ON human_questions(run_id) WHERE status = 'pending';
    `,
  },
  {
    version: 9,
    // Bounce loop-safety counter. A later belt step can send the run BACK to an earlier step for
    // rework (evidence/review → fix); each such bounce increments the target step's `bounces`, and
    // the reconciler escalates to attention once it exceeds limits.max_bounces. NOT NULL DEFAULT 0
    // backfills every existing run_steps row (in-flight runs across the upgrade start at zero).
    sql: `ALTER TABLE run_steps ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 10,
    // Pane-death confirmation. When a step's pane is CONFIRMED absent (herdr answered; the pane
    // wasn't listed) the reconciler records when that was first observed instead of respawning
    // immediately; only a second confirmed absence past the confirmation window respawns. NULL =
    // currently believed alive. This is the two-strike guard against a transient herdr blip
    // spawning a duplicate agent into a worktree whose original agent is still working.
    sql: `ALTER TABLE run_steps ADD COLUMN absent_at INTEGER;`,
  },
  {
    version: 11,
    // Transition outbox: source status write-backs are now INTENTS that persist until confirmed
    // delivered, not one-shot best-effort calls. A failed Jira transition used to be logged as
    // "deferred" and then dropped forever — the board's status of record diverged (To Do while a
    // PR was up), and because eligibility queries by status, a torn-down run's still-todo ticket
    // could be claimed AGAIN and merged work re-done. Every intended transition lands here first;
    // the reconciler retries undelivered rows each tick with exponential backoff (attempts /
    // next_attempt_at), in per-run id order so an old intent can't fire after a newer one.
    // UNIQUE(run_id, to_state) makes enqueue idempotent across retried claiming/teardown ticks.
    sql: `
      CREATE TABLE transition_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        work_source TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        to_state TEXT NOT NULL
          CHECK (to_state IN ('todo','in_development','in_review','merged','aborted','done')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(run_id, to_state)
      );
      CREATE INDEX idx_transition_outbox_pending ON transition_outbox(repo, next_attempt_at) WHERE delivered_at IS NULL;
      CREATE INDEX idx_transition_outbox_key ON transition_outbox(repo, work_source, ticket_key) WHERE delivered_at IS NULL;
    `,
  },
  {
    version: 12,
    // Attention re-notification clock. The one-shot notify on escalation was easy to miss and a
    // parked run then sat invisible indefinitely; the reconciler now re-notifies every
    // limits.attention_renotify_seconds while a run stays parked, tracked here.
    sql: `ALTER TABLE runs ADD COLUMN attention_notified_at INTEGER;`,
  },
  {
    version: 13,
    // Human-reply poll backoff. Waiting runs used to poll their source (a Jira listComments call
    // each) EVERY tick indefinitely — sustained per-minute load that scales with the parked-run
    // count for a reply that takes a human minutes-to-hours. Misses now back the next poll off
    // (60s doubling, capped at 5min), tracked per question. DEFAULT 0 = pre-existing questions
    // are immediately due.
    sql: `
      ALTER TABLE human_questions ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE human_questions ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 14,
    // Two-phase stale handling. A transition can now report "the item is no longer ours"
    // (deleted/transferred — TransitionResult "stale"): the LOCK-FREE outbox flush only marks the
    // intent delivered + stamps stale_at (mutating the run from there would race the run-locked
    // step machinery); the run-locked Phase A reconcile then consumes unhandled stale intents
    // (abort/park per policy) and stamps stale_handled_at, so one deleted item never double-fires.
    //
    // human_questions.poll_errors counts CONSECUTIVE pollHumanReply throws (reset on success or
    // reply) — distinct from poll_attempts, which counts genuine "no reply yet" misses (a slow
    // human is normal; a persistently-throwing source is not and escalates past a threshold).
    sql: `
      ALTER TABLE transition_outbox ADD COLUMN stale_at INTEGER;
      ALTER TABLE transition_outbox ADD COLUMN stale_handled_at INTEGER;
      ALTER TABLE human_questions ADD COLUMN poll_errors INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_transition_outbox_stale ON transition_outbox(run_id) WHERE stale_at IS NOT NULL AND stale_handled_at IS NULL;
    `,
  },
  {
    version: 15,
    // Capture-attempt safety cap for the evidence step. Each `capture-attempt` signal from an
    // evidence-gathering agent increments this; the reconciler parks the run for attention once it
    // exceeds limits.max_capture_attempts — so a flaky / nondeterministic app can't burn the run in
    // an endless re-record loop. Reset to 0 on each FRESH pass into the step (reconcileStep's forward
    // advance + resumeRun), NOT on crash-recovery respawn (which would let a self-crash game the cap).
    // NOT NULL DEFAULT 0 backfills every existing run_steps row.
    sql: `ALTER TABLE run_steps ADD COLUMN capture_attempts INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 16,
    // Evidence-upload outbox: the S3 media upload is now a durable INTENT retried until it lands, not a
    // one-shot the agent fires. When the AWS SSO session expired mid-run, the upload threw, the CLI
    // hard-failed, the bytes never reached S3, and the PR shipped with broken evidence links. Now the
    // CLI enqueues here (URLs are deterministic, published immediately) + attempts inline; the reconciler
    // retries undelivered rows at Phase 0 with exponential backoff (attempts / next_attempt_at, mirroring
    // transition_outbox) until S3 accepts them — and notifies the human to `aws sso login` when auth keeps
    // failing. `key_prefix` is persisted so retry URLs stay stable. `error_kind` (auth/transient/permanent)
    // drives the dashboard SSO light + the doctor stuck-upload check. `permanent_failed_at` is the single
    // terminal-failure state (no source-stale two-phase machinery — evidence has no "gone at source").
    // `next_attempt_at` doubles as an enqueue LEASE so the CLI's unlocked inline attempt and the server's
    // Phase 0 flush don't double-claim a row. UNIQUE(run_id, key_prefix) keeps enqueue idempotent while
    // still allowing several captures per run (a bounce re-enters evidence with a fresh prefix).
    sql: `
      CREATE TABLE evidence_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        evidence_dir TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        error_kind TEXT,
        notified_at INTEGER,
        permanent_failed_at INTEGER,
        abandoned_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(run_id, key_prefix)
      );
      CREATE INDEX idx_evidence_uploads_pending ON evidence_uploads(repo, next_attempt_at)
        WHERE delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL;
    `,
  },
  {
    version: 17,
    // Dynamic reviewing occupancy — the death of the fixed `watch_hours` deadline. A run in the
    // `reviewing` PR-watch used to hold a max_active_workspaces slot for the WHOLE watch, so
    // `watch_hours` existed only to eventually park it and reclaim that slot (at the cost of also
    // silencing the resolver). Occupancy is now per-run and dynamic: a reviewing run holds a slot
    // ONLY while its resolver agent is actively working. `resolver_active` is that flag — set when a
    // resolver is woken, cleared when its pane goes idle / the PR merges — and countOccupying counts
    // `reviewing AND resolver_active`. A PR can now be watched + auto-resolved for as long as review
    // takes without starving new claims, so the deadline is gone: `watch_deadline` is dropped
    // (nothing reads it). NOT NULL DEFAULT 0 backfills existing runs as "resolver idle" — correct,
    // since a genuinely mid-fix resolver re-asserts the flag on the next tick's pane-state check.
    sql: `
      ALTER TABLE runs ADD COLUMN resolver_active INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs DROP COLUMN watch_deadline;
    `,
  },
  {
    version: 18,
    // run_products: PR-watch state (pr_number / resolver_active / last_thread_sig) moves OFF the
    // `runs` table into a per-(run, product) table, so a future plugin product with a watch can
    // carry its own state instead of squatting on run columns. Behavior is UNCHANGED: the store
    // still exposes run.prNumber / resolverActive / lastThreadSig, now backed by this table via a
    // LEFT JOIN on product='pull_request' (absent row ⇒ NULL number/signature, active=0). Backfill
    // every run that had any of the three set into a 'pull_request' row (same transaction), then
    // DROP the now-unread runs columns (SQLite DROP COLUMN, exactly as v17 dropped watch_deadline).
    // UNIQUE(run_id, product) both dedups and indexes the join. Its created_at/updated_at seed from
    // the run's so backfilled rows keep a sensible mtime.
    sql: `
      CREATE TABLE run_products (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        product TEXT NOT NULL,
        number INTEGER,
        active INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id, product)
      );
      INSERT INTO run_products (run_id, product, number, active, signature, created_at, updated_at)
        SELECT id, 'pull_request', pr_number, resolver_active, last_thread_sig, created_at, updated_at
        FROM runs
        WHERE pr_number IS NOT NULL OR resolver_active <> 0 OR last_thread_sig IS NOT NULL;
      ALTER TABLE runs DROP COLUMN pr_number;
      ALTER TABLE runs DROP COLUMN resolver_active;
      ALTER TABLE runs DROP COLUMN last_thread_sig;
    `,
  },
  {
    version: 19,
    // source_auth: per-(repo, source) OAuth tokens for a work source configured with auth.method:
    // oauth (Phase 2). The api_token method keeps its credentials in the per-repo env file and never
    // touches this table. Tokens live in the LOCAL db (WAL, chmod'd) — no secret leaves the machine,
    // consistent with the "local only" guarantee. cloud_id/cloud_url come from Atlassian's
    // accessible-resources (the OAuth API base is https://api.atlassian.com/ex/jira/<cloud_id>).
    // refresh_token ROTATES on every refresh, so it's overwritten in place. PK (repo, source) — one
    // authenticated identity per configured source (INV-9's durable source name is the FK).
    sql: `
      CREATE TABLE source_auth (
        repo TEXT NOT NULL,
        source TEXT NOT NULL,
        method TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        cloud_id TEXT,
        cloud_url TEXT,
        scopes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, source)
      );
    `,
  },
  {
    version: 20,
    // account_label: the authenticated Jira account (whoami /rest/api/3/myself — displayName + email),
    // captured best-effort at login so the dashboard/CLI can show WHICH identity a source is signed in
    // as with no network call. Nullable — set only when the read:jira-user whoami succeeded; a token
    // refresh preserves it (the column isn't part of saveSourceAuth's upsert).
    sql: `ALTER TABLE source_auth ADD COLUMN account_label TEXT;`,
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
