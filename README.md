# herdr-factory

Autonomous work → PR **factory** that runs Claude worker agents across one
or more repos, on top of [herdr](https://herdr.dev) worktrees.

Point it at one or more **work sources** — a Jira board, a folder of markdown task
briefs — and walk away: the factory claims an item, spins up a herdr worktree, runs
Claude through fix → review → PR, watches the PR, and tears the worktree down on merge.
Sources are pulled in priority order under one global concurrency cap; each source has its
own branch template and pipeline agents. Two source types ship today: `jira` (status of
record lives in Jira) and `local_markdown` (lifecycle tracked internally by herdr-factory).

## Quick start

### Requirements

All of these must be on your `PATH`:

- `node` ≥ 24 and `pnpm` — the CLI runs `src/*.ts` directly via Node's built-in TypeScript support.
  [`mise`](https://mise.jdx.dev) is recommended: `mise.toml` pins node 24, and `bin/herdr-factory`
  runs via `mise exec` so it always uses node 24 even when a worker agent invokes it from another
  repo's worktree that activates a different node (`better-sqlite3` is a native module — the
  runtime node ABI must match the one it was built against)
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
pnpm install                                                                  # install dependencies
ln -s ~/dev/raza/herdr-factory/bin/herdr-factory ~/.local/bin/herdr-factory   # optional, for PATH
```

### 2. Add your Jira credentials

Create `~/.config/herdr-factory/env` (chmod 600) — these are global, shared by every repo:

```sh
JIRA_EMAIL=you@org.com
JIRA_API_TOKEN=...        # id.atlassian.com → Security → API tokens
```

These are just the Jira **auth** (one Atlassian account — an API token authenticates against
any site that account can reach). *Where* each repo polls work from — the Atlassian site
(`base_url`), project, board, label, statuses — is per-repo, set in its `config.yml` (next).

### 3. Configure a repo

Copy the example config and edit it for your repo:

```sh
cp -r examples/example-repo ~/.config/herdr-factory/repos/<name>
```

In `repos/<name>/config.yml`, set:

- `repo.path` / `repo.base_ref` — the main checkout and the branch worktrees fork from
  (repo-global; `~` / `$HOME` are expanded)
- `limits` — repo-global tuning, incl. `max_active` (the global concurrency cap across sources)
- `work_sources` — an ordered, **priority-ranked** list (≥1). Each entry has a `type`
  (`jira` | `local_markdown`), an optional `name` (default = type, unique per repo) and
  `priority` (lower = pulled first), its own `workspace_name` branch template (must include
  `{{ticket_id}}`), its own `agents.{fix,review,pr}` blocks, and a type-specific block:
  - `jira:` — `base_url` / `project` / `board` / `label` / the three `status` names
  - `local_markdown:` — `folder` (a directory of task briefs; each top-level item is either a
    single `*.md` file *or* a top-level subdirectory containing at least one top-level `*.md`,
    keyed by filename/dirname, with status tracked internally — the source is never modified). A
    directory item is copied whole into the worktree so multi-file briefs (spec + assets) work.

Each agent block has the agent's **`prompt_type`**, optionally a `prompt_file`, and optionally a
`tab` / `pane`:

Each agent can target a herdr layout **`tab` / `pane`** (set both, or neither):

- **With `tab` / `pane`** — the dispatcher waits for your layout to bring that pane up with
  an idle agent, then sends the step's prompt there. It never spawns its own pane for that
  step; if the pane never appears within `limits.layout_wait_seconds` (default 600), the
  ticket is flagged for **attention**. Use this when an external setup (e.g. the
  workspace-manager plugin) auto-spawns your tabs/panes/dev-servers/agents per worktree.
- **Without `tab` / `pane`** — herdr-factory spawns its own dedicated agent pane for the step.

Every agent also needs a **`prompt_type`** — it's required, with no silent default, so the
prompt the agent receives is never a surprise:

- **`augment`** *(recommended — start here)* — the engine ships a sensible built-in prompt
  for the step, and your `prompt_file` (optional in this mode) is appended to it as extra,
  repo-specific instructions. Begin with `augment` while you get a feel for how the agents
  behave; you only need to write down the repo-specific extras, not a whole prompt.
- **`replace`** — your `prompt_file` (required in this mode) is sent to the agent verbatim,
  so you own the entire prompt. Switch to `replace` once you understand the system and want
  full control.

In both modes the `prompt_file` lives in the repo folder and supports tokens like `@@KEY@@`,
`@@WORK_DOC@@` (the item's spec — `ticket.json` for Jira; `task.md` or, for a directory item,
`task/` for local_markdown), `@@WORK_DOC_KIND@@` (how to describe it in prose), and
`@@STEP_DONE_CMD@@`. Optionally add repo-specific guidance to `guidelines-prompt.md` (appended to
every agent prompt in either mode; delete it if unused). The `augment` built-in is resolved per
source type (`src/prompts/<type>/<step>.md`, else the shared `src/prompts/<step>.md`).

### 4. Define the herdr layout

Lay out one tab/pane per agent that starts `claude`, matching `agents.fix.tab`/`.pane`,
`agents.review.*`, and `agents.pr.*`. The dispatcher sends each step's prompt into its
pane; if a pane is absent it falls back to opening its own. The
[workspace-manager plugin](https://github.com/razajamil/herdr-plugin-workspace-manager)
makes this layout reusable per repo.

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
herdr-factory restart                    # graceful server restart after a `git pull`
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
        │ Phase A: advance each active ticket   │ Phase B: claim new work up to cap
        ▼
  To Do ─claim─> In Progress ─PR+automated round─> In Review ─merged/closed─> teardown
   (label)        worktree + "cat" worker          script transitions;        rm worktree,
                  (fix → review → PR →              7h watch wakes the         branch, archive
                   10-min CI/bot round → done)      worker on new comments
```

A single idempotent reconciler (`reconcileRepo`), looped by the resident `serve` daemon, finds
eligible work, spins up one herdr worktree + Claude worker per item, watches the resulting PR, and
tears the worktree down on merge/close. **All polling is plain shell — no LLM tokens are spent
finding or watching work.** Claude agents run only for the jobs that need reasoning: the
fix → review → PR pipeline, and addressing review comments. The dispatcher is generic; everything
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
herdr-factory --repo <name> claim <KEY> [--source <name>]|teardown <KEY> [--source <name>]
herdr-factory --repo <name> step-done <KEY> <fix|review|pr> [--source <name>]   # agent → dispatcher (event-nudge)
herdr-factory serve|ensure-up [--restart]|restart|reload   # the server + its supervisor (no --repo)
herdr-factory install|uninstall|start|stop             # the one supervisor launchd job (no --repo)
herdr-factory capture-lock acquire|release <owner>     # machine-global, no --repo
herdr-factory doctor|help
```

`tick`/`step-done`/`claim`/`teardown` route through the running server when it's up (warm,
in-process reconcile) and fall back to running in-process when it isn't. `eligible` lists todo items
across all sources; `doctor` runs a per-source health check plus server liveness. `claim` takes
`--source` (defaulted when there's a single source); `teardown`/`step-done` take `--source` to
disambiguate a key active in more than one source.

## What's repo-specific (all in `repos/<name>/config.yml`)

repo checkout + base branch (repo-global) · `limits` incl. the global `max_active` cap ·
the `work_sources` list — each with its own `workspace_name` branch template, `agents.{fix,review,pr}`
blocks (each tab/pane + `prompt_type` + optional prompt_file), and type block (`jira`
base_url/project/board/label/3 statuses, or `local_markdown` folder) — plus the folder's agent
prompt files and optional `guidelines-prompt.md`. The engine's built-in step prompts (used by
`prompt_type: augment`) live in `src/prompts/` (per source type under `src/prompts/<type>/`).
Only the Jira **auth** (email + token, one Atlassian account) is global, in
`~/.config/herdr-factory/env`.

## Layout

```
bin/herdr-factory          CLI (selects a repo via --repo)
src/{server,server-client,supervisor}.ts   resident serve + its HTTP client + the ensure-up supervisor
src/core/*.ts           generic engine: reconcile · step · watch · branch · deps
src/prompts/*.md        engine default step prompts (the base for prompt_type: augment)
examples/example-repo/  config.yml + fix.md/review.md/pr.md + guidelines-prompt.md (copy to repos/<name>/)
~/.config/herdr-factory/   env (secrets) + repos/<name>/{config.yml, guidelines-prompt.md}
~/.local/state/herdr-factory/   herdr-factory.db · server.json · logs/ (supervisor) · <repo>/logs/
```

## Security note

Workers launch with `--dangerously-skip-permissions` so the loop runs unattended.
Each worker is confined to its own throwaway worktree, but can run commands, push
branches, and open PRs without prompting. Review `HERDR_FACTORY_CLAUDE_FLAGS` and
tighten per repo if desired.

## Platform

macOS (launchd). Portability is now down to its smallest seam: the only OS-specific piece is the
**scheduled `ensure-up`** — `src/launchd.ts` writes the launchd plist. To support Linux/Windows,
swap that one job for a systemd timer, cron entry, or Task Scheduler task that runs
`herdr-factory ensure-up` on an interval; the resident `serve` + the whole engine are
already platform-neutral Node. (herdr itself remains the broader portability question.)
