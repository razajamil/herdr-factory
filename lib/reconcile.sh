#!/bin/bash
# The reconciler. A tick observes reality and drives every active ticket ONE
# idempotent step along its phase machine, then claims new work up to the cap.
# Because all state is on disk and every action is idempotent, a tick can be
# killed at any point and the next one resumes cleanly. Source after all libs.

set -euo pipefail

# --- per-ticket phase machine ----------------------------------------------

reconcile_ticket() {
  local key
  local phase
  key="$1"
  phase="$(ledger_get "$key" phase)"
  case "$phase" in
    claiming)     reconcile_claiming "$key" ;;
    developing)   reconcile_developing "$key" ;;
    reviewing)    reconcile_reviewing "$key" ;;
    tearing_down) reconcile_teardown "$key" ;;
    attention|done) : ;; # left for a human / already finished
    *) log_warn "$key: unknown phase '$phase' — leaving untouched" ;;
  esac
}

# claiming: ensure worktree + worker exist, then flip to developing once Jira
# reflects In development. Each step is safe to repeat.
reconcile_claiming() {
  local key
  local branch
  local wid
  local wt
  key="$1"
  branch="$(ledger_get "$key" branch)"
  wid="$(ledger_get "$key" workspace_id)"

  if ! worktree_workspace_alive "$wid"; then
    wt="$(worktree_create "$branch")" || { log_error "$key: worktree create failed"; return 0; }
    wid="$(printf '%s' "$wt" | jq -r '.workspace_id // empty')"
    if [[ -z "$wid" ]]; then
      log_error "$key: worktree create returned no workspace id"
      return 0
    fi
    ledger_set "$key" workspace_id "$wid"
    ledger_set "$key" worktree_path "$(printf '%s' "$wt" | jq -r '.worktree_path // empty')"
    log_info "$key: worktree ready ($wid)"
  fi

  worker_spawn "$key" || return 0

  if jira_transition "$key" "$HERDR_CATS_STATUS_IN_DEV"; then
    ledger_set_phase "$key" developing
    log_info "$key: developing on $branch"
  else
    log_warn "$key: In-development transition deferred (will retry next tick)"
  fi
}

# developing: wait for an open PR (the only reliable success signal). Claude
# Code's reported status flaps to idle while it is *thinking*, so we never treat
# status as "finished" — instead a wall-clock budget is the safety net for a
# stuck or dead worker.
reconcile_developing() {
  local key
  local branch
  local pr
  local claimed
  local now
  key="$1"
  branch="$(ledger_get "$key" branch)"
  pr="$(pr_for_branch "$branch")"

  if [[ -n "$pr" ]]; then
    local state
    local number
    state="$(printf '%s' "$pr" | jq -r '.state')"
    number="$(printf '%s' "$pr" | jq -r '.number')"
    if [[ "$state" == "OPEN" || "$state" == "MERGED" ]]; then
      ledger_set_num "$key" pr_number "$number" # record asap for visibility
      # Only move to review once the worker has finished its post-PR automated
      # round (CI green + bot comments addressed), signalled by the done marker.
      if worker_is_done "$key" || [[ "$state" == "MERGED" ]]; then
        jira_transition "$key" "$HERDR_CATS_STATUS_REVIEW" || log_warn "$key: review transition deferred"
        ledger_set_num "$key" watch_deadline "$(( $(date +%s) + HERDR_CATS_WATCH_SECONDS ))"
        ledger_set_phase "$key" reviewing
        log_info "$key: PR #$number ready -> reviewing (watch ${HERDR_CATS_WATCH_HOURS}h)"
      else
        log_info "$key: PR #$number open; waiting for worker to finish automated checks"
      fi
      return 0
    fi
  fi

  # No PR yet — keep waiting until the development budget is exhausted.
  claimed="$(ledger_get "$key" claimed_at)"
  now="$(date +%s)"
  if [[ -n "$claimed" ]] && (( now - claimed > HERDR_CATS_DEVELOP_BUDGET )); then
    ledger_set_phase "$key" attention
    log_notify "herdr-cats: $key needs attention" \
      "No PR after $(( HERDR_CATS_DEVELOP_BUDGET / 60 ))min (worker: $(worker_pane_state "$(ledger_get "$key" pane_id)")). Inspect $(ledger_get "$key" workspace_id)."
  fi
}

reconcile_reviewing() {
  local key
  local result
  key="$1"
  result="$(watch_step "$key")"
  case "$result" in
    merged) log_info "$key: PR merged"; reconcile_teardown "$key" ;;
    closed) log_info "$key: PR closed without merge"; reconcile_teardown "$key" ;;
    timeout)
      ledger_set_phase "$key" attention
      log_notify "herdr-cats: $key watch timed out" \
        "${HERDR_CATS_WATCH_HOURS}h review watch expired; PR left open for a human."
      ;;
    *) : ;; # waiting / resolving / woke — keep watching
  esac
}

# Teardown is idempotent: re-runnable if a tick died mid-teardown.
reconcile_teardown() {
  local key
  key="$1"
  ledger_set_phase "$key" tearing_down
  worktree_teardown "$(ledger_get "$key" workspace_id)" "$(ledger_get "$key" branch)" "$(ledger_get "$key" worktree_path)"
  ledger_archive "$key"
  log_info "$key: torn down and archived"
}

# --- claiming new work ------------------------------------------------------

reconcile_claim() {
  local ticket
  local key
  local summary
  local type
  local branch
  ticket="$1"
  key="$(printf '%s' "$ticket" | jq -r '.key')"
  ledger_exists "$key" && return 0

  summary="$(printf '%s' "$ticket" | jq -r '.summary // ""')"
  type="$(printf '%s' "$ticket" | jq -r '.type // "Task"')"
  ledger_init "$key" "$summary" "$type"
  branch="$(worktree_branch_name "$key" "$type" "$summary")"
  ledger_set "$key" branch "$branch"
  log_info "$key: claimed -> $branch"
  reconcile_ticket "$key" # start immediately; idempotent
}

# --- the tick ---------------------------------------------------------------

reconcile_all() {
  local active
  local slots
  local eligible
  local claimed
  jira_require_auth || { log_error "Jira auth missing — skipping tick"; return 1; }
  ledger_dir_init

  # Phase A: advance everything already in flight.
  local key
  for key in $(ledger_active_keys); do
    reconcile_ticket "$key" || log_warn "$key: reconcile step errored (continuing)"
  done

  # Phase B: claim new work up to the concurrency cap.
  active="$(ledger_count_active)"
  slots=$(( HERDR_CATS_MAX_ACTIVE - active ))
  if (( slots <= 0 )); then
    log_info "at capacity ($active/$HERDR_CATS_MAX_ACTIVE) — not claiming"
    return 0
  fi

  eligible="$(jira_list_eligible)" || { log_warn "eligible-ticket query failed"; return 0; }
  claimed=0
  while IFS= read -r ticket; do
    [[ -z "$ticket" ]] && continue
    (( claimed >= slots )) && break
    if reconcile_claim "$ticket"; then
      claimed=$(( claimed + 1 ))
    fi
  done < <(printf '%s' "$eligible" | jq -c '.[]?')
  log_info "claimed $claimed new ticket(s); active now $(ledger_count_active)/$HERDR_CATS_MAX_ACTIVE"
}
