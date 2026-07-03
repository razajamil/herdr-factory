# herdr-factory

Autonomous work → PR **factory** that runs Claude worker agents across one
or more repos, on top of [herdr](https://herdr.dev) worktrees.

Point it at one or more **work sources** — a Jira board, a folder of markdown task briefs — and
define one or more **belts** that say what to *do* with the work, then walk away: the factory
claims an item, spins up a herdr worktree, and runs it through the belt's pipeline of agent steps.
A **belt** pairs a source with an ordered list of steps. Two belt types ship today:

- **`work_to_pull_request`** — the classic fix → review → pr flow. The engine owns the steps,
  rides the PR through CI + human review to merge, and tears the worktree down. "Walk away."
- **`custom`** — your own ordered, agent-driven steps (e.g. research → propose →
  create_jira_ticket). Each step owns its prompt; the run ends when the last step signals done.

Belts are walked in priority order under one global concurrency cap, and each belt can carry a
programmatic `match` predicate so several belts can share one source (first match wins). Two
source types ship: `jira` (status of record lives in Jira) and `local_markdown` (lifecycle
tracked internally by herdr-factory).

## Quick start

### Requirements

All of these must be on your `PATH`:

- `node` ≥ 24 — the CLI runs `src/*.ts` directly via Node's built-in type-stripping and stores
  state in the built-in `node:sqlite` (no native modules). `bin/herdr-factory` calls `node`
  directly; pin Node 24 with any version manager (a `.node-version` file is included, read by
  `nvm`/`fnm`/`asdf`/`mise`). A worker agent invokes the CLI from other repos' worktrees that may
  activate an older node, so the launcher uses the active `node` when it's ≥ 24, else re-execs with
  the Node 24 path the CLI baked on a prior run (`<state>/node-path`); run any command once under
  Node 24 (e.g. `install`) to seed that, after which it works from any directory.
- a package manager to install the runtime deps (`commander`, `yaml`, `zod`, and `hono` + its
  `node-server`/`zod-openapi`/`swagger-ui` adapters — all pure-JS): **`npm`** (bundled with Node)
  is enough to run it; **`pnpm`** is used for local development (the committed lockfile is
  `pnpm-lock.yaml`).
- `herdr` — the worktree/workspace server ([herdr.dev](https://herdr.dev))
- `claude` — the Claude Code CLI
- `git`, `gh` (authenticated)
- A Jira account with an API token, and `launchd` (macOS — see [Platform](#platform) for Linux)

(The TypeScript engine parses `config.yml` with the `yaml` package and talks HTTP via native
`fetch` — no `jq`/`yq`/`curl` needed; those were bash-prototype dependencies.)

The [herdr-plugin-workspace-manager](https://github.com/razajamil/herdr-plugin-workspace-manager)
plugin is recommended for easier management of herdr layouts per workspace or repo.

### 1. Install the CLI

```sh
git clone <this> ~/dev/raza/herdr-factory
cd ~/dev/raza/herdr-factory
npm install --omit=dev                                                        # runtime deps only (dev: `pnpm install`)
ln -s ~/dev/raza/herdr-factory/bin/herdr-factory ~/.local/bin/herdr-factory   # optional, for PATH
```

### 2. Add your Jira credentials

Credentials are **per-repo** — create `repos/<name>/env` (chmod 600):

```sh
JIRA_EMAIL=you@org.com
JIRA_API_TOKEN=...        # id.atlassian.com → Security → API tokens
```

These are just the Jira **auth**, and they live **only** in `repos/<name>/env` — there is no shared
global secrets file. *Where* each repo polls work from — the Atlassian site (`base_url`), project,
board, label, statuses — is per-repo, set in its `config.yml` (next).

### 3. Configure a repo

Copy the example config and edit it for your repo:

```sh
cp -r examples/example-repo ~/.config/herdr-factory/repos/<name>
```

In `repos/<name>/config.yml`, set:

- `repo.path` / `repo.base_ref` — the main checkout and the branch worktrees fork from
  (repo-global; `~` / `$HOME` are expanded)
- `limits` — repo-global tuning, incl. `max_active` (the global concurrency cap across belts)
- `work_sources` — backends (≥1): **where** work is pulled from. Each has a `type`
  (`jira` | `local_markdown`), an optional `name` (default = type, unique per repo), and a
  type-specific block. No pipeline lives here anymore — that's a belt.
  - `jira:` — `base_url` / `project` / `board` / `label` / the three `status` names
  - `local_markdown:` — `folder` (a directory of task briefs; each top-level item is either a
    single `*.md` file *or* a top-level subdirectory containing at least one top-level `*.md`,
    keyed by filename/dirname, with status tracked internally — the source is never modified). A
    directory item is copied whole into the worktree so multi-file briefs (spec + assets) work.
- `belt` — pipelines (≥1): **what** to do with the work. Each belt has a `name`, a `belt_type`, a
  `source` (referencing a `work_sources` name), a `priority` (lower = matched first), its own
  `workspace_name` branch template (must include `{{work_id}}`; other vars: `{{work_slug}}` (≤20),
  `{{work_full_slug}}` (≤50), `{{work_type}}`, `{{semantic_work_prefix}}` = fix/chore/feature — and a
  short unique suffix is appended automatically, so re-claiming a previously-merged ticket gets a
  fresh branch + a fresh PR), and an optional `match`.

**Belt selection.** At claim time belts are walked in `priority` order; the first belt whose
`match` predicate accepts an item claims it (**first match wins**). `match` is a path (relative to
the repo folder) to a `.ts` module whose `export default` is `(ctx) => boolean` (sync or async),
where `ctx = { item, source }`. A belt with no `match` accepts anything from its source. This is
how several belts can share one source (e.g. route Jira bugs to one belt, stories to another).

**Belt types.**

- **`work_to_pull_request`** — the classic fix → review → pr flow. The engine owns the three steps
  *and* ships their prompts and rides the PR through CI + human review to merge ("walk away"). Its
  `agents.{fix,review,pr}` block picks each step's layout pane (see below) and may OPTIONALLY add a
  `prompt_file` (+ a required `prompt_file_source`) that **augments** that step's engine prompt with
  repo-specific instructions. (`guidelines-prompt.md` still augments every step, and the worker
  reads the repo's own `CLAUDE.md`/skills natively.)
- **`custom`** — your own ordered `steps[]`, fully agent-driven. Each step has a `name` (a
  lowercase slug), a **required** `prompt_file` + `prompt_file_source` (the whole step body), an
  optional layout `tab`/`pane`, and optional `budget_seconds` / `heartbeat` (commit-stall detection,
  off by default). The run ends when the **last** step signals step-done — no PR, no review watch.

**Layout `tab` / `pane`** (set both, or neither — applies to a w2pr agent or a custom step):

- **With `tab` / `pane`** — the dispatcher waits for your layout to bring that pane up with an idle
  agent, then sends the step's prompt there. It never spawns its own pane for that step; if the
  pane never appears within `limits.layout_wait_seconds` (default 600), the item is flagged for
  **attention**. Use this when an external setup (e.g. the workspace-manager plugin) auto-spawns
  your tabs/panes/dev-servers/agents per worktree.
- **Without `tab` / `pane`** — herdr-factory spawns its own dedicated agent pane for the step.

**Prompts.** A step's `prompt_file` is the step body (custom) or an augmenting addendum to the
engine prompt (w2pr). `prompt_file_source` says where it's read from: **`config`** = relative to
this repo's config folder (`repos/<name>/`, read at config-load); **`repo`** = relative to the
target repo checkout, read from the run's **worktree at render time** — so the prompt can live
version-controlled in the codebase (a missing one surfaces when the step is dispatched). The engine
always prepends a small **handover scaffold** (you're step X of belt Y; the belt runs A → B → C;
the prior step's handoff is at `…`; when done, write your handoff and run step-done). Prompt files
support tokens like `@@KEY@@`, `@@BELT@@`, `@@STEPS@@`, `@@WORK_DOC@@` (the item's spec —
`ticket.json` for Jira; `task.md` or, for a directory item, `task/` for local_markdown),
`@@WORK_DOC_KIND@@`, `@@HANDOFF_IN@@`, and `@@STEP_DONE_CMD@@`. `guidelines-prompt.md` (if present)
is appended to *every* step of *every* belt; delete it if unused. The `work_to_pull_request`
built-ins live in `src/prompts/` (per source type under `src/prompts/<type>/`).

**Editor support.** Each `config.yml`'s first line is a modeline —
`# yaml-language-server: $schema=../../config.schema.json` — so the YAML language server gives
autocomplete + inline validation (required fields, enums, and **unknown-key** errors that catch the
classic `agents`-on-a-`custom`-belt mixup). The relative `../../` resolves to `<configDir>/`
for a deployed `repos/<name>/config.yml`, where **`herdr-factory install` writes the schema**
(regenerate after upgrading with `herdr-factory schema`); and to the **repo root** for the in-repo
`examples/example-repo/config.yml`, where a committed `config.schema.json` lives (regenerate with
`npm run schema`; a test guards it against drift). It's derived from the engine's own zod schema
(no drift) and is *structural* — the cross-field rules (belt `source` refs, unique names, layout
both-or-neither, `workspace_name` must contain `{{work_id}}`, file existence) are still validated at
load with readable errors.

### 4. Define the herdr layout

Lay out one tab/pane per belt step that starts `claude`, matching each step's `tab`/`pane`. The
dispatcher sends each step's prompt into its pane; if a pane is absent it falls back to opening its
own. The [workspace-manager plugin](https://github.com/razajamil/herdr-plugin-workspace-manager)
makes this layout reusable per repo — and since each belt names its worktrees distinctively
(`workspace_name`), your layout can key off the worktree name to provision the right panes.

### 5. Install and start

```sh
herdr-factory install      # one machine-wide job — no --repo (it serves every configured repo)
```

This registers a single `launchd` supervisor job that runs `ensure-up` on a schedule. `ensure-up`
keeps the resident **`serve`** daemon alive — one process that ticks every configured repo every
`tick_interval_seconds` and exposes a local HTTP API. Feed it work via any configured source — label
a Jira ticket with your configured `label` and move it to the `todo` status, or drop a `*.md` brief
in a local_markdown source's folder — and the factory takes it from there.

```sh
herdr-factory --repo <name> status      # see what's in flight (+ server/supervisor state)
herdr-factory --repo <name> logs         # tail the repo's dispatcher log
herdr-factory restart                    # force a restart now (a `git pull` auto-restarts within ~60s)
herdr-factory reload                      # hot-reload config (e.g. max_active) without a restart
```

---

# Reference

## How it works

```
launchd ─StartInterval─> herdr-factory ensure-up   (stateless one-shot: keeps `serve` up)
                                  │ (re)starts if down/wedged/outdated
                                  ▼
        herdr-factory serve   (one resident process, ticks EVERY repo + HTTP API on 127.0.0.1)
        │ Phase A: advance each active run       │ Phase B: claim new work (belt match) up to cap
        ▼
  todo ─claim(belt)─> running step₁ → … → stepₙ ─┬─ work_to_pull_request: → reviewing ─merged─> teardown
   (eligible)         worktree + one agent per     │  (PR + CI/bot round; 7h watch wakes the worker)
                      step (handoff between them)  ├─ ask-human → waiting_for_human → same step resumes
                                                   └─ custom: last step step-done ───────────> teardown
```

A single idempotent reconciler (`reconcileRepo`), looped by the resident `serve` daemon, finds
eligible work, picks a belt (priority order, first `match` wins), spins up one herdr worktree, and
runs one Claude agent per belt step, handing off between them. A `work_to_pull_request` belt then
watches its PR through to merge and tears the worktree down; a `custom` belt finishes when its last
step signals done. If an agent is blocked or unsure, it can run `ask-human`; the dispatcher posts a
source-native question (Jira comment today), polls for a reply, writes the answer into `.memory`, and
resumes the same step automatically. **All polling is plain shell — no LLM tokens are spent finding
or watching work.** Claude agents run only for the jobs that need reasoning: the belt's steps, and
(for `work_to_pull_request`) addressing review comments. The dispatcher is generic; everything
repo-specific lives in per-repo config, so the same engine drives many repos.

State is on disk (SQLite), so a tick can be killed at any point and the next one resumes. The DB —
not the server — is the source of truth: **every command runs in-process when no server is up**, so
a worker's `step-done` lands even while the server is restarting. Stopping the server never kills
in-flight workers (they live in the herdr server). The supervisor is a stateless scheduled one-shot,
so it's immune to the resident-daemon wedging that a `KeepAlive` loop is prone to after sleep/wake.

The worker runs *inside* the target repo's worktree, so it picks up that repo's
`CLAUDE.md`/skills natively — the brief stays generic, with only a few commands
injected from config plus an optional per-repo guidance addendum.

## Commands

```
herdr-factory --repo <name> tick|status|eligible|runs [--all]|timeline <KEY>|logs [N]
herdr-factory --repo <name> claim <KEY> [--belt <name>]|teardown <KEY> [--source <name>]
herdr-factory --repo <name> step-done <KEY> <step> [--source <name>]   # agent → dispatcher (event-nudge)
herdr-factory --repo <name> ask-human <KEY> <step> [--source <name>] --question-file <path>
herdr-factory serve|ensure-up [--restart]|restart|reload|update   # the server + its supervisor (no --repo)
herdr-factory install|uninstall|start|stop             # the one supervisor launchd job (no --repo)
herdr-factory schema [--stdout]                        # write the config.yml JSON Schema for editors (no --repo)
herdr-factory capture-lock acquire|release <owner>     # machine-global, no --repo
herdr-factory doctor|help
```

`tick`/`step-done`/`claim`/`teardown` route through the running server when it's up (warm,
in-process reconcile) and fall back to running in-process when it isn't. `eligible` lists todo items
across all sources; `doctor` runs a per-source health check plus server liveness. `claim` takes
`--belt` (which belt to run the item on; defaulted when there's a single belt); `step-done` takes
the belt step name and `--source` to disambiguate; `teardown` takes `--source` to disambiguate a
key active in more than one source. `ask-human` is the agent escape hatch for uncertainty: it records
a source-agnostic pending question, posts it through the work source, and pauses the run until a human
reply arrives.

`serve` exposes a local HTTP API on `127.0.0.1:8765` (Hono) with the OpenAPI spec at `/doc` and
Swagger UI at `/ui`. `update` pulls the latest code (hard reset to the branch's upstream) and
restarts onto it; the supervisor also does this automatically every ~60s unless
`HERDR_FACTORY_AUTO_UPDATE=0` is set.

OpenTelemetry traces and metrics are available when `HERDR_FACTORY_TELEMETRY=1` is set. For local
testing, run the Grafana LGTM stack with `docker compose -f docker-compose.telemetry.yml up`; see
[`docs/TELEMETRY.md`](docs/TELEMETRY.md).

## TUI

Running `herdr-factory` with **no arguments** opens a full-screen terminal UI as a front-end to the
factory (equivalently `herdr-factory-tui` or `npm run tui`), built on
[opentui](https://github.com/anomalyco/opentui). Navigation follows lazygit, with a
three-level focus hierarchy — top level (the tab bar) → a numbered section → a field: **`Tab` /
`Shift+Tab`** switch the top-level tabs, **number keys** jump to a numbered section within the current
tab, **arrows** move within the focused section, **`Esc`** pops back to the top level from any depth
(then a number key dives into a section), and **`q`** quits. Each tab remembers where you left it for
the session.

- **Dashboard** — per-repo status pulled live from the running server's HTTP API (`/health` +
  `/repos/{repo}/status` + `/eligible`); auto-refreshes every 3s and shows a start hint when the
  server is down. Rows are navigable (`↑↓`) and act on the highlighted row, each behind a
  confirmation: **`t`** tick a repo, **`c`** claim an eligible item onto a belt (picks the belt when
  the item's source has more than one), **`x`** teardown an active run, **`r`** refresh, and **`↵`**
  on a run opens its event timeline.
- **Config** — section **1** is a repo list; `↵` opens a repo into section **2**, a full editor for
  its `config.yml`. `↑↓` move between rows; `↵` edits a text field (type freely, `↵` = next field),
  cycles an enum (`←→` also cycle — e.g. a source's `type` or a belt's `belt_type`), toggles a bool,
  or runs an add/remove action row (removes pop a confirmation); `^S` saves. Each work source, belt,
  and step is a **collapsible group** — collapsed by default, labeled by its name, expanded with
  `↵`/`Space`/`→` or a click, and reordered within its list with **`Shift+↑/↓`** (or `[` / `]`) — so
  long configs stay scannable. It covers the whole file — the repo's Jira credentials (a masked
  `secrets (env)` section written to `repos/<name>/env`, chmod 600; the token is replace-only and
  never shown), `repo`, `limits`, and adding/editing/removing `work_sources` and `belt`s including
  their union type and nested steps/agents — validated against the engine's own schema, writing back
  with comments preserved.

Unlike the engine (Node ≥ 24), the TUI renders through opentui's native core, so it needs **Node ≥ 26
with FFI** — the launcher reaches for a Node 26 (active `node`, else `mise exec node@26`) and runs
with `--experimental-ffi`. Nothing else in the project depends on it.

## What's repo-specific (all in `repos/<name>/config.yml`)

repo checkout + base branch (repo-global) · `limits` incl. the global `max_active` cap · the
`work_sources` list (backends: `jira` base_url/project/board/label/3 statuses, or `local_markdown`
folder) · the `belt` list — each with a `belt_type`, a `source` ref, `priority`, `workspace_name`
branch template, optional `match` predicate (a `.ts` file in the folder), and either an
`agents.{fix,review,pr}` layout block (`work_to_pull_request`) or an ordered `steps[]` with their
`prompt_file`s (`custom`) — plus those custom step prompt files, any `match` `.ts` files, and an
optional `guidelines-prompt.md`. The engine's built-in `work_to_pull_request` prompts live in
`src/prompts/` (per source type under `src/prompts/<type>/`). The Jira **auth** (email + token) is
**per-repo only**, in `repos/<name>/env`.

## Layout

```
bin/herdr-factory          CLI launcher → node src/cli/index.ts (guards Node ≥ 24)
src/cli/                CLI: commander program (selects a repo via --repo)
src/server/             resident serve (Hono + OpenAPI) · app · schemas · HTTP client
src/watchers/           launchd job · ensure-up supervisor · self-updater
src/core/*.ts           generic engine: reconcile · step · watch · branch · deps
src/prompts/*.md        built-in work_to_pull_request step prompts (per type under <type>/)
examples/example-repo/  config.yml + custom step prompts + match-bugs.ts + guidelines-prompt.md (copy to repos/<name>/)
~/.config/herdr-factory/   config.schema.json (editor schema) + repos/<name>/{config.yml, env (per-repo Jira secrets), guidelines-prompt.md}
~/.local/state/herdr-factory/   herdr-factory.db · server.json · logs/ (supervisor) · <repo>/logs/
```

## Security note

Workers launch with `--dangerously-skip-permissions` (hardcoded as `CLAUDE_FLAGS` in
`src/core/step.ts`) so the loop runs unattended. Each worker is confined to its own throwaway
worktree, but can run commands, push branches, and open PRs without prompting. To tighten, change
`CLAUDE_FLAGS` in `src/core/step.ts`.

## Platform

macOS (launchd). Portability is now down to its smallest seam: the only OS-specific piece is the
**scheduled `ensure-up`** — `src/watchers/launchd.ts` writes the launchd plist. To support Linux/Windows,
swap that one job for a systemd timer, cron entry, or Task Scheduler task that runs
`herdr-factory ensure-up` on an interval; the resident `serve` + the whole engine are
already platform-neutral Node. (herdr itself remains the broader portability question.)
