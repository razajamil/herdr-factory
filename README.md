# herdr-cats 🐱

Autonomous Jira → PR loop that **herds Claude worker agents ("cats")** across one
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
launchd ──every 180s──> herdr-cats --repo <name> tick   (idempotent reconciler)
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
git clone <this> ~/dev/raza/herdr-cats
ln -s ~/dev/raza/herdr-cats/bin/herdr-cats ~/.local/bin/herdr-cats   # optional, for PATH
```

**Global secrets** — `~/.config/herdr-cats/env` (chmod 600):
```
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=you@org.com
JIRA_API_TOKEN=...        # id.atlassian.com → Security → API tokens
```

## Onboard a repo

1. `cp examples/repo.conf.example ~/.config/herdr-cats/repos/<name>.conf` and fill it in
   (repo checkout path, base branch, Jira project/board/label/statuses, and optionally
   the repo's bootstrap / de-slop / resolve commands + a guidance file).
2. Define that repo's herdr "fix" layout in the workspace-manager plugin — a tab
   `main` with a pane `agent` that starts `claude` (configurable via
   `HERDR_CATS_MAIN_TAB`/`AGENT_PANE`). The dispatcher sends the brief there;
   if the pane is absent it falls back to opening its own.
3. `herdr-cats --repo <name> install`

The worker runs *inside* the target repo's worktree, so it picks up that repo's
`CLAUDE.md`/skills natively — the brief stays generic, with only a few commands
injected from config plus an optional per-repo guidance addendum.

## Commands

```
herdr-cats --repo <name> tick|status|eligible|claim <KEY>|teardown <KEY>|logs [N]
herdr-cats --repo <name> install|uninstall|start|stop
herdr-cats capture-lock acquire|release <owner>     # machine-global, no --repo
herdr-cats help
```

## What's repo-specific (all in `repos/<name>.conf`)

repo checkout + base branch · Jira project/board/label/3 statuses · bootstrap
command · de-slop command · PR-resolve command · optional brief-guidance file ·
herdr layout tab/pane names · concurrency/watch/budget tuning. The Jira **token**
is global (one Atlassian account) and lives in `~/.config/herdr-cats/env`.

## Layout

```
bin/herdr-cats          CLI (selects a repo via --repo)
lib/*.sh                generic engine: log lock jira ledger worktree worker pr watch reconcile config
templates/worker-brief.md   generic worker brief (config-injected + guidance addendum)
install-launchd.sh      per-repo launchd job (com.herdr-cats.<repo>)
examples/               repo.conf.example, repo-guidance.md.example
~/.config/herdr-cats/   env (secrets) + repos/<name>.conf
~/.local/state/herdr-cats/<repo>/   tickets, locks, logs   (+ _shared/locks for the global capture lock)
```

## Security note

Workers launch with `--dangerously-skip-permissions` so the loop runs unattended.
Each worker is confined to its own throwaway worktree, but can run commands, push
branches, and open PRs without prompting. Review `HERDR_CATS_CLAUDE_FLAGS` and
tighten per repo if desired.

## Platform

macOS (launchd). The engine is portable shell; only `install-launchd.sh` is
mac-specific — swap it for a systemd unit or cron entry on Linux.
