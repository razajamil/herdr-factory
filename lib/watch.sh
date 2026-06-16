#!/bin/bash
# PR-review watching. All polling is deterministic shell (no LLM). An agent is
# woken ONLY when there is genuine actionable review work. To stay token-cheap
# and keep ticket context warm, we re-prompt the SAME idle worker agent rather
# than spawning a fresh one — falling back to a fresh spawn only if it has died.
# Source after the other libs (needs worker_pane_alive/worker_pane_state).

set -euo pipefail

watch_deadline_passed() {
  local dl
  dl="$(ledger_get "$1" watch_deadline)"
  [[ -n "$dl" && "$dl" != "null" ]] || return 1
  (( $(date +%s) > dl ))
}

# Single-line instruction (no newlines — it is typed into the worker's TUI).
_watch_resolver_prompt() {
  local key
  local number
  local hint
  key="$1"
  number="$2"
  hint=""
  [[ -n "$HERDR_CATS_RESOLVE_CMD" ]] && hint=" following the $HERDR_CATS_RESOLVE_CMD workflow (run $HERDR_CATS_RESOLVE_CMD $number)"
  printf 'New review activity on PR #%s for %s. Address ALL unresolved review comments and fix ALL failing CI checks on this PR%s: fix each thread, commit per thread, push, resolve the thread. Review your changes for quality before pushing. Do NOT transition Jira. When every thread is resolved and CI is green, or you are blocked, stop and say so.' \
    "$number" "$key" "$hint"
}

# Wake an agent to resolve the PR. Reuse the tracked worker pane; else spawn fresh.
watch_wake_resolver() {
  local key
  local wid
  local number
  local pane
  local worktree
  local prompt
  local out
  local newpane
  key="$1"
  wid="$(ledger_get "$key" workspace_id)"
  number="$(ledger_get "$key" pr_number)"
  prompt="$(_watch_resolver_prompt "$key" "$number")"
  pane="$(ledger_get "$key" pane_id)"

  if [[ -n "$pane" ]] && worker_pane_alive "$pane"; then
    "$HERDR_CATS_HERDR_BIN" agent send "$pane" "$prompt" >/dev/null 2>&1 || return 1
    "$HERDR_CATS_HERDR_BIN" pane send-keys "$pane" Enter >/dev/null 2>&1 || true
    log_info "$key: re-prompted live worker ($pane) to resolve PR #$number"
    return 0
  fi

  worktree="$(ledger_get "$key" worktree_path)"
  # RESOLVER_FLAGS is an intentional word list; first token after -- is the exe.
  # shellcheck disable=SC2086
  out="$("$HERDR_CATS_HERDR_BIN" agent start claude --workspace "$wid" --cwd "$worktree" --no-focus \
    -- "$HERDR_CATS_CLAUDE_CMD" $HERDR_CATS_RESOLVER_FLAGS "$prompt" 2>/dev/null)" || {
      log_error "$key: failed to wake resolver for PR #$number"
      return 1
    }
  newpane="$(printf '%s' "$out" | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  [[ -n "$newpane" ]] && ledger_set "$key" pane_id "$newpane"
  log_info "$key: spawned fresh resolver for PR #$number${newpane:+ in $newpane}"
}

# Decide + act for a ticket in the 'reviewing' phase.
# Echoes one of: merged | closed | timeout | resolving | waiting | woke
watch_step() {
  local key
  local branch
  local pr
  local state
  local number
  local sig_line
  local unresolved
  local failing
  local sig
  local last_sig
  local wstate
  key="$1"
  branch="$(ledger_get "$key" branch)"

  pr="$(pr_for_branch "$branch")"
  if [[ -z "$pr" ]]; then
    printf 'waiting\n'; return 0
  fi
  state="$(printf '%s' "$pr" | jq -r '.state')"
  number="$(printf '%s' "$pr" | jq -r '.number')"
  [[ "$(ledger_get "$key" pr_number)" == "$number" ]] || ledger_set_num "$key" pr_number "$number"

  case "$state" in
    MERGED) printf 'merged\n'; return 0 ;;
    CLOSED) printf 'closed\n'; return 0 ;;
  esac

  if watch_deadline_passed "$key"; then
    printf 'timeout\n'; return 0
  fi

  sig_line="$(pr_review_signature "$number")"
  unresolved="${sig_line%%|*}"
  failing="$(printf '%s' "$sig_line" | cut -d'|' -f2)"
  sig="${sig_line##*|}"
  last_sig="$(ledger_get "$key" last_thread_sig)"

  # Nothing actionable -> idle wait.
  if [[ "$unresolved" -eq 0 && "$failing" -eq 0 ]]; then
    printf 'waiting\n'; return 0
  fi
  # Already handled this exact state.
  if [[ "$sig" == "$last_sig" ]]; then
    printf 'resolving\n'; return 0
  fi
  # Don't pile on while the agent is mid-fix.
  wstate="$(worker_pane_state "$(ledger_get "$key" pane_id)")"
  if [[ "$wstate" == "working" ]]; then
    printf 'resolving\n'; return 0
  fi

  if watch_wake_resolver "$key"; then
    ledger_set "$key" last_thread_sig "$sig"
    printf 'woke\n'
  else
    printf 'waiting\n'
  fi
}
