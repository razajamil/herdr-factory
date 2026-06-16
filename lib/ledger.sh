#!/bin/bash
# The ledger is the single source of truth for in-flight tickets and the reason
# the loop is stop/restart-safe: all per-ticket state lives on disk, one JSON
# file per ticket, written atomically (temp + mv). A tick reads the ledger,
# observes reality (Jira/herdr/gh) and drives each ticket one idempotent step.
#
#   $HERDR_CATS_TICKETS_DIR/<KEY>.json   active tickets (counted against the cap)
#   $HERDR_CATS_TICKETS_DIR/done/<KEY>.json   archived after teardown
#
# phase lifecycle:
#   claiming    -> ledger created + lock held; ensure In development + worktree + worker
#   developing  -> worker agent running; await idle + open PR
#   reviewing   -> PR open, Jira in review; watch for comments/merge/close/timeout
#   tearing_down-> PR merged/closed; remove worktree + workspace
#   attention   -> needs a human; reconciler leaves it alone (still holds a slot)

# jq filters below use single quotes with jq-internal vars ($f, $v) by design.
# shellcheck disable=SC2016

set -euo pipefail

ledger_dir_init() { mkdir -p "$HERDR_CATS_TICKETS_DIR/done"; }

ledger_path() { printf '%s/%s.json\n' "$HERDR_CATS_TICKETS_DIR" "$1"; }
ledger_exists() { [[ -f "$(ledger_path "$1")" ]]; }

ledger_init() {
  local key
  local summary
  local type
  local path
  key="$1"
  summary="$2"
  type="$3"
  path="$(ledger_path "$key")"
  [[ -f "$path" ]] && return 0
  ledger_dir_init
  jq -cn --arg key "$key" --arg summary "$summary" --arg type "$type" \
    --arg now "$(date +%s)" '{
      key: $key, summary: $summary, type: $type,
      phase: "claiming", claimed_at: ($now|tonumber),
      branch: null, workspace_id: null, pane_id: null, worktree_path: null,
      pr_number: null, watch_deadline: null,
      last_thread_sig: null, resolver_busy: false
    }' >"$path"
}

ledger_get() {
  local key
  local field
  key="$1"
  field="$2"
  jq -r --arg f "$field" '.[$f] // empty' "$(ledger_path "$key")" 2>/dev/null
}

# Apply a jq filter atomically. Extra args are passed through to jq.
_ledger_apply() {
  local key
  local filter
  local path
  local tmp
  key="$1"
  filter="$2"
  shift 2
  path="$(ledger_path "$key")"
  [[ -f "$path" ]] || return 1
  tmp="$(mktemp)"
  if jq -c "$@" "$filter" "$path" >"$tmp"; then
    mv -f "$tmp" "$path"
  else
    rm -f "$tmp"
    return 1
  fi
}

ledger_set()      { _ledger_apply "$1" '.[$f] = $v'         --arg f "$2" --arg v "$3"; }
ledger_set_num()  { _ledger_apply "$1" '.[$f] = ($v|tonumber)' --arg f "$2" --arg v "$3"; }
ledger_set_bool() { _ledger_apply "$1" '.[$f] = ($v == "true")' --arg f "$2" --arg v "$3"; }
ledger_set_phase(){ ledger_set "$1" phase "$2"; }

# Active = occupies a worktree slot (everything not yet archived).
ledger_active_keys() {
  ledger_dir_init
  find "$HERDR_CATS_TICKETS_DIR" -maxdepth 1 -name '*.json' -exec basename {} .json \; 2>/dev/null | sort
}
ledger_count_active() { ledger_active_keys | grep -c . || true; }

# Archive a finished ticket out of the active dir so it frees a slot.
ledger_archive() {
  local key
  local path
  key="$1"
  path="$(ledger_path "$key")"
  [[ -f "$path" ]] || return 0
  ledger_dir_init
  ledger_set "$key" phase "done" || true
  ledger_set "$key" archived_at "$(date +%s)" || true
  mv -f "$path" "$HERDR_CATS_TICKETS_DIR/done/$key.json"
}
