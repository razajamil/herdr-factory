# herdr-factory

Autonomous Jira → PR **factory** that runs Claude worker agents across one
or more repos, on top of [herdr](https://herdr.dev) worktrees.

A single idempotent reconciler (`tick`), driven by `launchd`, finds eligible Jira
tickets, spins up one herdr worktree + Claude worker per ticket, watches the
resulting PR, and tears the worktree down on merge/close. **All polling is plain
shell — no LLM tokens are spent finding or watching work.** Claude agents run
only for the two jobs that need reasoning: writing the fix+PR, and addressing
review comments. The dispatcher is generic; everything repo-specific lives in
per-repo config, so the same engine drives many repos.

## How it works

```
launchd ──every 60s──> herdr-factory --repo <name> tick   (idempotent reconciler)
        │ Phase A: advance each active ticket   │ Phase B: claim new work up to cap
        ▼
  To Do ─claim─> In Progress ─PR+automated round─> In Review ─merged/closed─> teardown
   (label)        worktree + "cat" worker          script transitions;        rm worktree,
                  (fix → quality → PR →             7h watch wakes the         branch, archive
                   10-min CI/bot round → done)      worker on new comments
```

State is on disk (an atomic ledger, one JSON per ticket), so a tick can be killed
at any point and the next one resumes. `launchctl bootout` never kills in-flight
workers (they live in the herdr server); `bootstrap` resumes from the ledger.

## Install

```
git clone <this> ~/dev/raza/herdr-factory
ln -s ~/dev/raza/herdr-factory/bin/herdr-factory ~/.local/bin/herdr-factory   # optional, for PATH
```

**Requirements:** `herdr`, `git`, `gh`, `jq`, `yq` (mikefarah v4, reads `config.yml`), `curl`, and the `claude` CLI — all on `PATH`.

**Global secrets** — `~/.config/herdr-factory/env` (chmod 600):
```
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=you@org.com
JIRA_API_TOKEN=...        # id.atlassian.com → Security → API tokens
```

## Onboard a repo

1. `cp -r examples/example-repo ~/.config/herdr-factory/repos/<name>` and edit its
   `config.yml` (repo checkout path, base branch, Jira project/board/label/statuses,
   the `workspace_name` branch template, and the required `agents.{fix,review,pr}`
   blocks). Author each agent's prompt file (`fix.md` / `review.md` / `pr.md` in that
   folder); put any repo-specific guidance in `guidelines-prompt.md` (optional —
   appended verbatim to every agent prompt; delete it if unused).
2. Define that repo's herdr layout in the workspace-manager plugin — one tab/pane per
   agent that starts `claude`, matching `agents.fix.tab`/`.pane`, `agents.review.*`,
   `agents.pr.*`. The dispatcher dispatches each step's prompt into its pane; if a pane
   is absent it falls back to opening its own.
3. `herdr-factory --repo <name> install`

The worker runs *inside* the target repo's worktree, so it picks up that repo's
`CLAUDE.md`/skills natively — the brief stays generic, with only a few commands
injected from config plus an optional per-repo guidance addendum.

## Commands

```
herdr-factory --repo <name> tick|status|eligible|claim <KEY>|teardown <KEY>|logs [N]
herdr-factory --repo <name> install|uninstall|start|stop
herdr-factory --repo <name> step-done <KEY> <fix|review|pr>   # an agent → dispatcher signal (event-nudges)
herdr-factory capture-lock acquire|release <owner>     # machine-global, no --repo
herdr-factory help
```

## What's repo-specific (all in `repos/<name>/config.yml`)

repo checkout + base branch · `workspace_name` branch template · Jira
project/board/label/3 statuses · the three `agents.{fix,review,pr}` blocks (each
tab/pane + prompt_file) · concurrency/watch/budget tuning — plus the folder's
agent prompt files and optional `guidelines-prompt.md`.
The Jira **token** is global (one Atlassian account) in `~/.config/herdr-factory/env`.

## Layout

```
bin/herdr-factory          CLI (selects a repo via --repo)
src/core/*.ts           generic engine: reconcile · step · watch · branch · deps
examples/example-repo/  config.yml + fix.md/review.md/pr.md + guidelines-prompt.md (copy to repos/<name>/)
~/.config/herdr-factory/   env (secrets) + repos/<name>/{config.yml, guidelines-prompt.md}
~/.local/state/herdr-factory/<repo>/   tickets, locks, logs   (+ _shared/locks for the global capture lock)
```

## Security note

Workers launch with `--dangerously-skip-permissions` so the loop runs unattended.
Each worker is confined to its own throwaway worktree, but can run commands, push
branches, and open PRs without prompting. Review `HERDR_FACTORY_CLAUDE_FLAGS` and
tighten per repo if desired.

## Platform

macOS (launchd). The engine is portable shell; only `install-launchd.sh` is
mac-specific — swap it for a systemd unit or cron entry on Linux.
