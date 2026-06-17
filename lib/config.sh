#!/bin/bash
# Central configuration for herdr-cats. Sourced by bin/herdr-cats (which sets
# HERDR_CATS_HOME and, from `--repo <name>`, HERDR_CATS_REPO). Never run directly.
#
# Two config layers, both OUTSIDE any target repo:
#   ~/.config/herdr-cats/env                  global secrets/defaults (Jira token)
#   ~/.config/herdr-cats/repos/<repo>.conf    per-repo settings (see examples/)
# Runtime state is namespaced per repo:
#   ~/.local/state/herdr-cats/<repo>/         tickets, locks, logs
#
# Every value here is consumed by other sourced scripts, not this file.
# shellcheck disable=SC2034

set -euo pipefail

: "${HERDR_CATS_HOME:?HERDR_CATS_HOME must be set by bin/herdr-cats}"
HERDR_CATS_LIB="$HERDR_CATS_HOME/lib"
HERDR_CATS_TEMPLATES="$HERDR_CATS_HOME/templates"
HERDR_CATS_CLI="$HERDR_CATS_HOME/bin/herdr-cats"

# Which target repo this invocation is for (set by `--repo <name>`). Empty is
# fine for repo-agnostic commands (help, capture-lock).
HERDR_CATS_REPO="${HERDR_CATS_REPO:-}"

# --- Config files -----------------------------------------------------------
# Global env (sourced bash) holds secrets: JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN.
# Per-repo config is a FOLDER  ~/.config/herdr-cats/repos/<repo>/  containing:
#   config.yml            settings, read with yq (see examples/example-repo/)
#   guidelines-prompt.md  optional; appended verbatim to every worker brief

HERDR_CATS_CONFIG_DIR="${HERDR_CATS_CONFIG_DIR:-$HOME/.config/herdr-cats}"
HERDR_CATS_ENV_FILE="$HERDR_CATS_CONFIG_DIR/env"
HERDR_CATS_REPO_DIR="$HERDR_CATS_CONFIG_DIR/repos/$HERDR_CATS_REPO"
HERDR_CATS_REPO_YML="$HERDR_CATS_REPO_DIR/config.yml"

if [[ -f "$HERDR_CATS_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$HERDR_CATS_ENV_FILE"
fi

# Read a scalar from the repo's config.yml ("" if absent). Set a var only when
# the yaml provides it, so config.yml overrides the env and an omitted key falls
# through to the built-in defaults below.
_cats_yq() { yq "$1 // \"\"" "$HERDR_CATS_REPO_YML" 2>/dev/null; }
_cats_yset() {
  local _v
  _v="$(_cats_yq "$2")"
  if [[ -n "$_v" && "$_v" != "null" ]]; then
    printf -v "$1" '%s' "$_v"
  fi
  return 0 # never fail (absent key is fine) — guards against set -e abort
}

if [[ -n "$HERDR_CATS_REPO" && -f "$HERDR_CATS_REPO_YML" ]]; then
  command -v yq >/dev/null 2>&1 || { printf 'Error: yq is required to read %s\n' "$HERDR_CATS_REPO_YML" >&2; exit 1; }
  _cats_yset HERDR_CATS_REPO_CWD       '.repo.path'
  _cats_yset HERDR_CATS_BASE_REF       '.repo.base_ref'
  _cats_yset HERDR_CATS_GH_REPO        '.repo.github'
  _cats_yset HERDR_CATS_JIRA_PROJECT   '.jira.project'
  _cats_yset HERDR_CATS_JIRA_BOARD     '.jira.board'
  _cats_yset HERDR_CATS_JIRA_LABEL     '.jira.label'
  _cats_yset HERDR_CATS_STATUS_TODO    '.jira.status.todo'
  _cats_yset HERDR_CATS_STATUS_IN_DEV  '.jira.status.in_development'
  _cats_yset HERDR_CATS_STATUS_REVIEW  '.jira.status.review'
  _cats_yset HERDR_CATS_BOOTSTRAP_CMD  '.worker.bootstrap_cmd'
  _cats_yset HERDR_CATS_DESLOP_CMD     '.worker.deslop_cmd'
  _cats_yset HERDR_CATS_RESOLVE_CMD    '.worker.resolve_cmd'
  _cats_yset HERDR_CATS_MAIN_TAB       '.layout.main_tab'
  _cats_yset HERDR_CATS_AGENT_PANE     '.layout.agent_pane'
  _cats_yset HERDR_CATS_MAX_ACTIVE     '.limits.max_active'
  _cats_yset HERDR_CATS_WATCH_HOURS    '.limits.watch_hours'
  _cats_yset HERDR_CATS_DEVELOP_BUDGET '.limits.develop_budget_seconds'
  _cats_yset HERDR_CATS_TICK_INTERVAL  '.limits.tick_interval_seconds'
fi

# --- Runtime state (per repo) ----------------------------------------------

HERDR_CATS_STATE_ROOT="${HERDR_CATS_STATE_ROOT:-$HOME/.local/state/herdr-cats}"
HERDR_CATS_STATE_DIR="$HERDR_CATS_STATE_ROOT/${HERDR_CATS_REPO:-_default}"
HERDR_CATS_TICKETS_DIR="$HERDR_CATS_STATE_DIR/tickets"
HERDR_CATS_LOCKS_DIR="$HERDR_CATS_STATE_DIR/locks"
HERDR_CATS_LOGS_DIR="$HERDR_CATS_STATE_DIR/logs"
# The dev-server/screenshot capture lock is machine-global, not per repo.
HERDR_CATS_SHARED_LOCKS_DIR="$HERDR_CATS_STATE_ROOT/_shared/locks"

# --- Jira (REST + API token, basic auth) ------------------------------------
# Token/email/URL are global (one Atlassian account) and belong in the env file.
# project/board/label/statuses are per repo (the repos/<repo>.conf).
JIRA_BASE_URL="${JIRA_BASE_URL:-}"
JIRA_BASE_URL="${JIRA_BASE_URL%/}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"

HERDR_CATS_JIRA_PROJECT="${HERDR_CATS_JIRA_PROJECT:-}"
HERDR_CATS_JIRA_BOARD="${HERDR_CATS_JIRA_BOARD:-}"
HERDR_CATS_JIRA_LABEL="${HERDR_CATS_JIRA_LABEL:-agent}"
# Status names exactly as Jira reports them (transition matching is
# case-insensitive, so capitalization drift is harmless — but keep accurate).
HERDR_CATS_STATUS_TODO="${HERDR_CATS_STATUS_TODO:-To Do}"
HERDR_CATS_STATUS_IN_DEV="${HERDR_CATS_STATUS_IN_DEV:-In Progress}"
HERDR_CATS_STATUS_REVIEW="${HERDR_CATS_STATUS_REVIEW:-In Review}"

# --- Target repo ------------------------------------------------------------

# Main (non-linked) checkout of the target repo — required to do work. herdr
# refuses to create worktrees from a linked worktree, so this must be the parent
# checkout.
HERDR_CATS_REPO_CWD="${HERDR_CATS_REPO_CWD:-}"
HERDR_CATS_BASE_REF="${HERDR_CATS_BASE_REF:-origin/main}"
# GitHub owner/name for PR ops; derived from the checkout's origin if empty.
HERDR_CATS_GH_REPO="${HERDR_CATS_GH_REPO:-}"

# --- Loop behaviour ---------------------------------------------------------

HERDR_CATS_MAX_ACTIVE="${HERDR_CATS_MAX_ACTIVE:-3}"
HERDR_CATS_WATCH_HOURS="${HERDR_CATS_WATCH_HOURS:-7}"
HERDR_CATS_WATCH_SECONDS=$(( HERDR_CATS_WATCH_HOURS * 3600 ))
# Max wall-clock in "developing" before flagging a human. Claude's reported
# status flaps to idle while thinking, so only an open PR counts as success and
# this is the stuck/dead-worker safety net.
HERDR_CATS_DEVELOP_BUDGET="${HERDR_CATS_DEVELOP_BUDGET:-5400}" # 90 min
HERDR_CATS_TICK_INTERVAL="${HERDR_CATS_TICK_INTERVAL:-180}"
HERDR_CATS_MAX_IMAGES="${HERDR_CATS_MAX_IMAGES:-8}"
HERDR_CATS_MAX_IMAGE_BYTES="${HERDR_CATS_MAX_IMAGE_BYTES:-10485760}" # 10 MiB

# --- Worker agents ----------------------------------------------------------

HERDR_CATS_CLAUDE_CMD="${HERDR_CATS_CLAUDE_CMD:-claude}"
# Autonomous workers must not stall on permission prompts. Broad permissions,
# confined to a throwaway worktree — tighten in the env/repo config if desired.
HERDR_CATS_CLAUDE_FLAGS="${HERDR_CATS_CLAUDE_FLAGS:---dangerously-skip-permissions}"
HERDR_CATS_RESOLVER_FLAGS="${HERDR_CATS_RESOLVER_FLAGS:---dangerously-skip-permissions}"
HERDR_CATS_WORKER_PROMPT="${HERDR_CATS_WORKER_PROMPT:-Read .memory/herdr-cats/brief.md in this worktree and follow it exactly. This is an autonomous task — do not pause to ask for confirmation.}"

# Each fresh worktree is expected to get a layout with a tab+pane the worker runs
# in (applied by the workspace-manager plugin). We dispatch the brief to the
# claude that layout starts there; fall back to our own pane if absent.
HERDR_CATS_MAIN_TAB="${HERDR_CATS_MAIN_TAB:-main}"
HERDR_CATS_AGENT_PANE="${HERDR_CATS_AGENT_PANE:-agent}"
HERDR_CATS_LAYOUT_WAIT="${HERDR_CATS_LAYOUT_WAIT:-120}"

# --- Repo-specific worker steps (injected into the brief) -------------------
# Leave empty for generic behaviour; set per repo for that repo's commands.
HERDR_CATS_BOOTSTRAP_CMD="${HERDR_CATS_BOOTSTRAP_CMD:-}"   # from .worker.bootstrap_cmd
HERDR_CATS_DESLOP_CMD="${HERDR_CATS_DESLOP_CMD:-}"         # from .worker.deslop_cmd
HERDR_CATS_RESOLVE_CMD="${HERDR_CATS_RESOLVE_CMD:-}"       # from .worker.resolve_cmd
# Repo guidance is convention-based: <repo config folder>/guidelines-prompt.md
# (appended to every brief if present).
HERDR_CATS_BRIEF_GUIDANCE="${HERDR_CATS_BRIEF_GUIDANCE:-$HERDR_CATS_REPO_DIR/guidelines-prompt.md}"

# --- Tooling ----------------------------------------------------------------

HERDR_CATS_HERDR_BIN="${HERDR_CATS_HERDR_BIN:-${HERDR_BIN_PATH:-herdr}}"

# --- launchd (one job per repo) ---------------------------------------------

HERDR_CATS_LAUNCHD_LABEL="${HERDR_CATS_LAUNCHD_LABEL:-com.herdr-cats.${HERDR_CATS_REPO:-default}}"
HERDR_CATS_LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$HERDR_CATS_LAUNCHD_LABEL.plist"
