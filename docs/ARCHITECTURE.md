# herdr-cats — Architecture

Autonomous Jira → PR loop that herds Claude worker agents ("cats") across one or
more repos, on top of [herdr](https://herdr.dev) worktrees. A single idempotent
reconciler (`tick`), driven by `launchd`, finds eligible Jira tickets, spins up
one herdr worktree + Claude worker per ticket, watches the PR, and tears the
worktree down on merge/close.

This document is the canonical design of the TypeScript implementation
(run via `tsx`, no build step) backed by SQLite.

---

## 1. Principles

1. **herdr owns the terminal world; herdr-cats orchestrates it.** All
   workspace / worktree / tab / pane / layout / agent lifecycle is performed by
   the `herdr` CLI. herdr-cats never reimplements pane splitting, layout
   application, terminal multiplexing, raw `git worktree add`, or spawning
   `claude` as a bare child process. See [§4](#4-herdr-ownership-boundary).
2. **SQLite is the single source of truth for runtime state**, designed as the
   data contract for a future web UI — including a rich **event timeline**, not
   just current state. Config is never in SQLite.
3. **The reconciler is pure and testable.** It depends on injected interfaces
   (`Store`, `HerdrClient`, `JiraClient`, …, `now()`), so it runs against fakes
   and an in-memory DB in tests.
4. **Repo-specifics are decoupled into per-repo config**, not code. The engine
   is generic; onboarding a repo is pure data.
5. **Stop/restart safe.** State is on disk (SQLite); every action is idempotent;
   `launchctl bootout` never kills in-flight workers (they live in herdr).

---

## 2. Stack

| Concern | Choice |
|---|---|
| Language / runtime | TypeScript on Node 22, run via **`tsx`** (no build step) |
| CLI | **commander** |
| State store | **better-sqlite3** (synchronous — ideal for a short-lived tick) |
| Config | **`yaml`** + **`zod`** (parse + validate → types) |
| Subprocess (herdr/gh/git) | **`node:child_process`** `execFile` (arg arrays, no shell) |
| HTTP (Jira REST) | native **`fetch`** |
| Tests | **vitest** (dev-only) |
| External CLIs | **herdr**, **gh**, **git** |

Runtime dep footprint: `commander`, `better-sqlite3`, `yaml`, `zod` (+ `tsx` to
run). Everything else is Node built-ins or the external CLIs.

---

## 3. Layered architecture

```
                 ┌───────────────────────── cli.ts (commander) ──────────────┐
                 │  --repo selector · command dispatch · --json output         │
                 └───────────────┬───────────────────────────┬───────────────┘
                                 ▼                           ▼
        ┌──────────────── core/ (PURE, testable) ────────────────┐     launchd.ts
        │  reconcile · watch · worker(brief) · branch · phases     │  (plist + ctl)
        │  depends only on interfaces ↓↓↓                          │
        └───────┬───────────────────────────────┬─────────────────┘
                ▼                                 ▼
      ┌──── db/ store (SQLite) ─┐       ┌──── clients/ (thin glue) ───────┐
      │ runs · events · locks  │       │ HerdrClient  JiraClient          │
      │ repos · migrations     │       │ GitHubClient GitClient  exec()   │
      └────────────────────────┘       └───────────┬──────────────────────┘
                                                    ▼
                                       herdr · gh · git · fetch(Jira REST)
```

**Dependency rule:** `core` imports *interfaces*; `cli` constructs the concrete
implementations and injects them. Tests substitute fakes + `:memory:` SQLite.

### Repo layout

```
herdr-cats/
  package.json  tsconfig.json  README.md  docs/ARCHITECTURE.md
  bin/herdr-cats          cwd-robust shell launcher → `node --import tsx src/cli.ts`
                          (resolves its own dir through symlinks; symlinked into ~/.local/bin)
  src/
    cli.ts                commander program; builds deps, dispatches, structured log
    config.ts             env + repos/<name>/config.yml → zod → typed Config
    types.ts              shared domain types
    db/{index,migrate,store}.ts
    clients/{exec,herdr,jira,github,git}.ts
    core/{deps,branch,worker,watch,reconcile}.ts
    launchd.ts
  templates/worker-brief.md
  examples/example-repo/{config.yml, guidelines-prompt.md}
  test/                   vitest
```

Config/state live OUTSIDE any repo:
`~/.config/herdr-cats/{env, repos/<name>/{config.yml, guidelines-prompt.md}}` and
`~/.local/state/herdr-cats/{herdr-cats.db, <repo>/logs/}`.

---

## 4. herdr ownership boundary

This is a load-bearing principle, not an aside. herdr already implements
worktrees, workspaces, tabs, panes, layouts, and agent lifecycle — **we do not
rebuild any of it.** `HerdrClient` is a *thin typed wrapper*: every method shells
out to `herdr …` and parses its JSON; it contains zero terminal/worktree logic.

**herdr owns (via the CLI — never reimplemented):**

- worktree **create / open / remove** (incl. deleting the checkout dir + git
  worktree registration)
- workspace **close / get / list**
- tab **create / list**
- pane **split / run / send-text / send-keys / list**
- agent **start / list / status / send / rename**
- desktop **notifications**

**The fix layout** (a tab `main` with a pane `agent`, plus dev-server / review /
etc. panes) is applied by the external **workspace-manager herdr plugin** on
`worktree.created`. herdr-cats does **not** apply layouts — it relies on the plugin
and simply *targets* the resulting panes: the `main`/`agent` pane for the worker
(configurable via `worker.main_tab` / `worker.agent_pane`) and, if a `review` block
is configured, its `review.tab` / `review.pane` for the review agent. If a targeted
pane is absent it degrades gracefully (see [§8](#8-worker-model)).

**herdr-cats performs git/filesystem ops ONLY for things outside herdr's model:**

- `git branch -D <branch>` on teardown — the one remnant herdr leaves (herdr
  models worktrees, not branches)
- read/maintenance git: `show-ref`, `remote get-url`, defensive `worktree prune`
- everything non-terminal: Jira REST, GitHub via `gh`, SQLite, config, the
  reconciler logic

If a future need looks like "manage a pane/tab/worktree/agent," it belongs in
`HerdrClient` as another CLI call — not as reimplemented logic.

---

## 5. Clients

Thin, typed wrappers. Types encode the real `herdr --json` shapes
reverse-engineered during the bash prototype.

- **`exec.ts`** — `run(cmd,args,{cwd,input,allowFail})`, `runJson<T>()` over
  `execFile` (promisified; arg arrays → no shell injection).
- **`herdr.ts`** —
  - `worktreeCreateOrOpen(repoCwd, branch, baseRef) → {workspaceId, worktreePath, paneId}`
    (parses `.result.workspace.workspace_id` / `.worktree.checkout_path` /
    `.result.root_pane.pane_id`; **only from the main checkout** — herdr refuses
    linked worktrees)
  - `worktreeRemove(workspaceId)` — removes workspace + dir + git registration
  - `agents() → Agent[]` (`.result.agents`; status field is `agent_status` ∈
    `idle|working|done|blocked|unknown`)
  - `agentStart({workspaceId, cwd, argv}) → paneId` where
    **`argv = ["claude", ...flags, prompt]`** (first token is the executable)
  - `paneByLabel(ws, tabLabel, paneLabel)`, `paneHasClaude(pane)`,
    `paneRun(pane, cmd)`, `agentSend(pane, text)`, `paneSendKeys(pane, "Enter")`,
    `agentRename(pane, "cat:KEY")`, `notify(title, body)`
- **`jira.ts`** (fetch + basic auth) — `listEligible()` via the Agile board
  endpoint `/rest/agile/1.0/board/<id>/issue?jql=…` (keeps board scoping);
  `getIssue`, `currentStatus`, `transition(key, target)` (case-insensitive
  `.to.name` match, no-op if already there), `downloadImages(key, dir)` (image/*
  only, capped; site-host `content` URL + basic auth).
- **`github.ts`** (`gh` via execFile) — `prForBranch(repo, branch)`,
  `reviewSignature(repo, n) → {unresolved, failing, sig}` (graphql review threads
  + `statusCheckRollup`).
- **`git.ts`** — `branchExists`, `branchDelete`, `originUrl`, `worktreePrune`.

---

## 6. State — SQLite (better-sqlite3)

One global DB `~/.local/state/herdr-cats/herdr-cats.db`. `db/index.ts` sets
`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;` then runs migrations
(`schema_version` + ordered SQL). Per-repo ticks write concurrently to the one
DB; WAL + busy_timeout + the per-repo single-instance lock keep that safe.

```sql
CREATE TABLE repos(name TEXT PRIMARY KEY, repo_path TEXT, base_ref TEXT, github TEXT,
  last_tick_at INTEGER, enabled INTEGER DEFAULT 1);

CREATE TABLE runs(                       -- ONE attempt at a ticket (history kept)
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, ticket_key TEXT NOT NULL,
  summary TEXT, issue_type TEXT, branch TEXT, phase TEXT NOT NULL,
  workspace_id TEXT, pane_id TEXT, worktree_path TEXT, pr_number INTEGER,
  watch_deadline INTEGER, last_thread_sig TEXT, worker_done INTEGER DEFAULT 0,
  review_done INTEGER DEFAULT 0, review_pane TEXT,   -- auto_review gate (migration v2)
  progress_sig TEXT, progress_at INTEGER,            -- worker heartbeat (migration v3)
  attention_reason TEXT, outcome TEXT,   -- merged|closed|abandoned|timeout|NULL
  created_at INTEGER, updated_at INTEGER, ended_at INTEGER);
CREATE INDEX idx_runs_active ON runs(repo) WHERE ended_at IS NULL;

CREATE TABLE events(                     -- the timeline (web-UI gold)
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, repo TEXT, ticket_key TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT);  -- detail = JSON
CREATE INDEX idx_events_run ON events(run_id, ts);

CREATE TABLE locks(name TEXT PRIMARY KEY, owner TEXT, acquired_at INTEGER, expires_at INTEGER);
CREATE TABLE schema_version(version INTEGER);
```

`db/store.ts` (synchronous): `countActive(repo)`, `activeRuns(repo)`,
`activeRunForTicket(repo,key)`, `createRun`, `updateRun(id,patch)`,
`endRun(id,outcome)`, `recordEvent(runId,repo,key,type,detail?)`,
`acquireLock/releaseLock(name,owner,ttl)`, `upsertRepo`, `touchTick`.

**Active = `ended_at IS NULL`** (this is what the concurrency cap counts).
`attention` keeps `ended_at` NULL so it still holds a slot until a human/teardown
resolves it. History is never deleted (we set `ended_at`), so the web UI can show
attempts, outcomes, and durations.

**event types:** `claimed · transition · worktree_created · worker_spawned ·
pr_opened · resolver_woken · worker_done · merged · closed · torn_down ·
attention · error`.

---

## 7. The reconciler (phase machine)

`core/reconcile.ts` → `reconcileRepo(deps)`:

- **Phase A** — advance every `activeRuns(repo)` one idempotent step.
- **Phase B** — claim eligible Jira tickets up to `maxActive`.

Per-run errors are caught → recorded as an `error` event → the tick continues.
A per-repo single-instance lock prevents overlapping ticks.

```
  To Do ──claim──────────> claiming ──ensure worktree+worker, transition In Dev──> developing
  (label)                                                                              │
                                          PR open AND worker_done ─────────────────────┤
                                                                                       │
                          ┌─ review configured ─> auto_review ─review_done/budget─┐    │
                          │  (spawn review agent; gate on review-done)            │    │
                          └─ no review ──────────────────────────────────────────┴────┤
                                              transition Review, set 7h deadline        │
                                                                                       ▼
                                                                                  reviewing
   ┌───────────────────────────────────────────────────────────────────────────────┤
   │ watch.reviewStep each tick (≤ deadline): new comments/failing checks → wake     │
   │ resolver (reuse worker pane); merged/closed → teardown; deadline → attention    │
   ▼                                                                                  │
 tearing_down ──herdr worktree remove + git branch -D──> done (ended_at set)          │
                                                                                       │
 (no PR past develop budget, OR PR open but silent past worker_done grace — both        │
  when not "working"; OR no commits for stall_seconds) ─────────> attention ───────────┘
```

Phase gates of note:
- **developing → reviewing** is gated on **`worker_done`** (the worker's explicit
  signal), never on flappy agent status. Three safety nets catch a worker that
  never signals, all escalating to `attention`:
  - **no PR** within `develop_budget`, and **PR open but silent** for
    `worker_done_grace` (anchored to PR-open, so the window is the same for a 5-min
    and a 5-hr task) — both fire only when the worker isn't actively `working`, so a
    still-working worker is *extended* and long tasks aren't false-flagged.
  - **heartbeat/stall**: the branch HEAD is probed each tick (`git rev-parse HEAD`);
    a moving HEAD resets a progress clock (`progress_at`), so any amount of real
    work keeps the run alive regardless of total runtime. If HEAD doesn't move for
    `stall_seconds`, the run is **stalled** → `attention`, *even if the agent still
    reports `working`* — this is what catches a hung-but-`working` worker. (Residual:
    a worker doing very long stretches of *uncommitted* work can look stalled; raise
    `stall_seconds` if that's common — the signal is commits, not file edits.)
- **auto_review** is inserted between developing and reviewing **only when a
  `review` block is configured**. The dispatcher spawns the review agent and holds
  the run until `review_done` (set by `herdr-cats review-done <KEY>`); a
  `review_budget_seconds` timeout proceeds best-effort so a stuck review never
  wedges the PR, and a dead review pane is re-spawned idempotently. With no `review`
  block the lifecycle is unchanged (developing → reviewing directly).
- The worker is always tracked by its **exact `pane_id`** (the layout spawns
  other agents in the workspace; "first claude" would read the wrong one); the
  review agent is tracked separately by `review_pane`.

---

## 8. Worker model

Unchanged from the proven design; all spawning is via herdr.

1. **Dispatch into the layout's worker pane** — the `main_tab` / `agent_pane`
   labels from config (default `main`/`agent`). Wait (bounded) for the
   workspace-manager plugin to apply the layout, then `herdr agent send` the
   brief to the `claude` it started there + `pane send-keys Enter`. If the pane
   has no claude → `herdr pane run "claude …"` in it. If the pane never appears →
   fall back to `herdr agent start`. Store the resulting `pane_id`; rename the
   agent **`cat:<KEY>`**.
2. **Brief** is rendered from `templates/worker-brief.md` (template literals — no
   `sed` escaping), injecting the repo's bootstrap command, and the per-repo
   `guidelines-prompt.md` is appended verbatim. The worker runs *inside the target
   repo's worktree*, so it inherits that repo's `CLAUDE.md`/skills natively — the
   brief stays generic. The brief carries **no review step**: review is a
   deterministic dispatcher-owned phase, not something the worker is asked to do.
3. **Flow:** read ticket + downloaded images → implement → tests/verify →
   screenshot evidence to **gitignored `.memory/herdr-cats/evidence`**
   (best-effort, under the machine-global capture lock) → open PR (**code only**)
   → attach the screenshots **inline to the PR description** as GitHub
   `user-attachments` (uploaded via the browser; **never committed to the repo**)
   → ~10-min automated round (CI green + bot comments) → **signal done**.
4. **worker-done handshake (CLI → DB):** the worker calls
   `herdr-cats --repo <name> worker-done <KEY>`, which sets `worker_done=1` and
   records a `worker_done` event. The reconciler reads the flag to gate
   developing → (auto_review →) reviewing. (Replaces the old marker file; also a
   timeline entry.)
5. **Review agent (optional, `core/review.ts`):** if a `review` block is configured,
   the reconciler — *not* the worker — dispatches a dedicated review agent into
   `review.tab` / `review.pane` once the worker is done (see [§auto_review](#7-the-state-machine)).
   Its prompt is the **contents** of `review.prompt_file` plus a footer telling it to
   commit/push any changes and then run `herdr-cats --repo <name> review-done <KEY>`.
   That `review-done` signal (sets `review_done=1`) is what releases the gate; a
   `review_budget_seconds` timeout backstops a stuck or silent review. Same handshake
   shape as worker-done, but driven entirely by the dispatcher so it can't be skipped.

The capture lock is **machine-global** (one dev-server/browser at a time across
all repos) — a `locks` row, acquired with a TTL, exposed via the CLI for workers.

---

## 9. Teardown

herdr-first, with the single git-domain remnant:

```
1. herdr worktree remove --workspace <id> --force   → workspace + checkout dir + git registration
2. git branch -D <branch>                            → the only remnant herdr leaves
```

Verified empirically: current herdr `worktree remove` removes the workspace, the
directory, and the git worktree registration; it leaves only the local branch
(standard `git worktree remove` behavior — herdr doesn't model branches). So
`rm -rf <dir>`, `git worktree prune`, and a separate `workspace close` are
**defensive-only fallbacks** (run only if herdr somehow leaves remnants), not the
primary path. Deleting the local branch lets a re-claim of the same ticket start
fresh off the base ref instead of reattaching old commits. The remote/PR branch
is GitHub's domain (merge auto-delete or left as-is).

---

## 10. Config

- **Global secrets** — `~/.config/herdr-cats/env` (chmod 600):
  `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. One Atlassian account, all repos.
- **Per-repo** — `~/.config/herdr-cats/repos/<name>/`:
  - `config.yml` — parsed with `yaml`, validated with `zod` → typed `Config`:
    - `repo` — `path` / `base_ref` / `github`
    - `workspace_name` — branch-name template for each cat (the worktree +
      workspace derive from it). Vars: `{{ticket_id}}`, `{{ticket_short_slug}}`
      (≤20 chars), `{{ticket_slug}}` (≤50), `{{ticket_type}}`, `{{ticket_prefix}}`
      (`fix`/`chore`/`feature`, by issue type). The rendered name is sanitised to
      a git-safe ref; zod requires the template to contain `{{ticket_id}}` (else
      cats would collide on one branch). Default when unset:
      `{{ticket_prefix}}/{{ticket_id}}-{{ticket_slug}}` (rendered by `core/branch.ts`).
    - `jira` — `project` / `board` / `label` / 3 `status` names
    - `worker` — `bootstrap_cmd` / `resolve_cmd`, plus `main_tab` / `agent_pane`
      (the herdr fix-layout tab/pane the worker is dispatched into; default
      `main`/`agent`)
    - `review` — **optional**; omit to skip review entirely. `tab` / `pane` (the
      herdr layout pane the review agent runs in) + `prompt_file` (path relative to
      the repo config dir; its contents become the review agent's prompt)
    - `limits` — `max_active` / `watch_hours` / `develop_budget_seconds` /
      `worker_done_grace_seconds` / `stall_seconds` / `review_budget_seconds` /
      `tick_interval_seconds`
  - `guidelines-prompt.md` — optional; appended verbatim to every worker brief.
- `config.ts` asserts `repo.path` is a **main checkout** (not a linked worktree),
  since herdr can't create worktrees from one.

Onboarding a repo is pure data: drop a `repos/<name>/` folder, define its herdr
layout (workspace-manager plugin), `herdr-cats --repo <name> install`.

---

## 11. CLI surface (commander)

```
herdr-cats --repo <name> tick | status | eligible | claim <KEY> | teardown <KEY>
herdr-cats --repo <name> worker-done <KEY>          # the worker calls this (CLI → DB)
herdr-cats --repo <name> install | uninstall | start | stop | logs [N]
herdr-cats --repo <name> runs [--all] | timeline <KEY>   # read the DB
herdr-cats capture-lock acquire|release <owner>     # machine-global, no --repo
herdr-cats doctor                                   # herdr socket / gh / jira / db / claude checks
herdr-cats help
```

`status` is a dashboard, not just a count: an **ACTIVE** section (each cat's
ledger phase + **live** herdr worker status + PR + summary) and a **FINISHED**
section (each completed cat's outcome, newest first), under a
`Cats: N running (cap M) · K finished` header. `runs`/`timeline` read the same DB.

Each command builds `Deps` (open DB, construct clients from config) and calls
core. `--repo` is a global option; repo-scoped commands assert it.

---

## 12. launchd

One job per repo, `com.herdr-cats.<repo>`. `launchd.ts` generates the plist and
drives `launchctl bootstrap/bootout`.

- `ProgramArguments = [node, "--import", "tsx", "<abs>/src/cli.ts", "--repo", "<name>", "tick"]`
- `EnvironmentVariables`: captured `PATH` + `HOME` (no experimental flags —
  better-sqlite3 needs none). Secrets are **not** in the plist; the tick
  re-reads the env file.
- `StartInterval` from config; per-repo stdout/err logs. launchd won't run two
  copies of a job concurrently (backs up the tick's own lock).

---

## 13. Testing

vitest. Store tested against `:memory:` SQLite (run lifecycle, active counting,
lock TTL). `core/reconcile` tested with fake clients + in-memory store + an
injected `now()` → deterministic phase-machine assertions. Every bug from the
bash prototype is encoded as a regression test (see §14). Clients get thin
contract tests; a live read-only smoke via `doctor`/`eligible`.

---

## 14. Invariants to preserve

Hard-won from the bash prototype — encode as types/tests/asserts:

- `agentStart` argv: first token is the `claude` executable. Track the worker by
  its **exact `pane_id`** (the layout spawns extra agents).
- herdr `worktree create` only from the **main checkout** → asserted in config.
- **Teardown = `herdr worktree remove --workspace --force` (herdr owns
  workspace+dir+registration) + `git branch -D <branch>` (the sole git remnant).**
  `rm -rf` / `prune` / `workspace close` are defensive-only fallbacks.
- Jira transition match is **case-insensitive** on `.to.name`; no-op if already
  in target.
- worktree-create / agent-list JSON shapes are typed once in `herdr.ts`.
- attachment `content` is site-host → basic-auth download; image/* + size cap.
- developing → reviewing gates on **`worker_done`**, not flappy status;
  `developBudget` is the stuck-worker safety net.
- single-instance per-repo tick lock; WAL + `busy_timeout` for the shared DB.

---

## 15. Build milestones

| M | Deliverable | Gate |
|---|---|---|
| M0 | scaffold (package.json, tsconfig, tsx, commander `help`, dirs) | `herdr-cats help` runs |
| M1 | `db/` + `store` + migrations | vitest store suite green (`:memory:`) |
| M2 | `config.ts` (yaml + zod) | loads real reckon-frontend config.yml; rejects a bad one |
| M3 | clients (herdr/jira/github/git) | read-only live: `eligible`, `getIssue`, `agents`, `prForBranch` match known shapes |
| M4 | core reconcile/worker/watch | vitest phase-machine suite green |
| M5 | cli wiring all commands | `status`/`eligible`/`runs` read-only against reckon-frontend |
| M6 | launchd + guarded single-ticket run | one real ticket end-to-end (watched), then `install` |

The bash loop is already decommissioned, so there is no parallel-run/double-claim
risk: build, validate read-only, do one guarded single-ticket run, then install.

**Status:** M0–M6 complete — installed and running unsupervised
(`com.herdr-cats.reckon-frontend`, 60 s tick); the full lifecycle has been
validated end-to-end (claim → worktree → worker → In Development → PR → review →
teardown).

---

## 16. Web UI (future)

The SQLite schema is the contract; a future UI is a *reader*. Active dashboard =
`runs WHERE ended_at IS NULL`; history + metrics (time-to-PR, success rate,
time-in-review) derive from `runs` + `events`; per-ticket timeline = `events`
joined to `run`. Options: point **Datasette** at the DB for an instant read-only
view; later a `herdr-cats serve` JSON API or a Next.js app reading via
better-sqlite3.
