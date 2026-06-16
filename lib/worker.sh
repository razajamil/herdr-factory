#!/bin/bash
# Spawns and inspects the per-ticket worker agent. Source after the other libs.
#
# The worker is a normal Claude Code session in the worktree's herdr workspace,
# surviving independently of the dispatcher. We track it by its EXACT pane_id
# (captured at spawn), because the workspace-manager plugin may auto-start other
# agents (claude/opencode) in the same fresh worktree — keying off "first claude
# in the workspace" would read the wrong agent's status.

set -euo pipefail

# Escape a value for safe use as a sed `s|...|VALUE|` replacement (\, &, |).
_sed_repl_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

# Render the brief + fetch ticket context into the worktree's .memory (gitignored).
worker_materialize_brief() {
  local key
  local worktree
  local mem
  local evidence_rel
  key="$1"
  worktree="$2"
  mem="$worktree/.memory/herdr-cats"
  evidence_rel=".pr-evidence/$key"
  mkdir -p "$mem/images"

  jira_get_issue "$key" >"$mem/ticket.json" 2>/dev/null || log_warn "$key: could not save ticket.json"
  jira_download_images "$key" "$mem/images" || log_warn "$key: image download had issues"

  # Repo-specific steps, injected from config (generic wording when unset).
  local bootstrap_text
  local deslop_text
  if [[ -n "$HERDR_CATS_BOOTSTRAP_CMD" ]]; then
    bootstrap_text="Bootstrap the worktree: \`$HERDR_CATS_BOOTSTRAP_CMD\`."
  else
    bootstrap_text="Bootstrap the worktree if needed (install deps / run the repo's setup)."
  fi
  if [[ -n "$HERDR_CATS_DESLOP_CMD" ]]; then
    deslop_text="Run \`$HERDR_CATS_DESLOP_CMD\` over your changes and apply its cleanups."
  else
    deslop_text="Review your own diff and remove unnecessary complexity / AI slop before pushing."
  fi

  sed \
    -e "s|@@KEY@@|$(_sed_repl_escape "$key")|g" \
    -e "s|@@TYPE@@|$(_sed_repl_escape "$(ledger_get "$key" type)")|g" \
    -e "s|@@SUMMARY@@|$(_sed_repl_escape "$(ledger_get "$key" summary)")|g" \
    -e "s|@@BRANCH@@|$(_sed_repl_escape "$(ledger_get "$key" branch)")|g" \
    -e "s|@@WORKTREE@@|$(_sed_repl_escape "$worktree")|g" \
    -e "s|@@MEMORY_DIR@@|.memory/herdr-cats|g" \
    -e "s|@@EVIDENCE_DIR@@|$(_sed_repl_escape "$evidence_rel")|g" \
    -e "s|@@CATS_CLI@@|$(_sed_repl_escape "$HERDR_CATS_CLI")|g" \
    -e "s|@@BOOTSTRAP@@|$(_sed_repl_escape "$bootstrap_text")|g" \
    -e "s|@@DESLOP@@|$(_sed_repl_escape "$deslop_text")|g" \
    "$HERDR_CATS_TEMPLATES/worker-brief.md" >"$mem/brief.md"

  # Append repo-specific guidance (skills/commands/conventions) if configured.
  if [[ -n "$HERDR_CATS_BRIEF_GUIDANCE" && -f "$HERDR_CATS_BRIEF_GUIDANCE" ]]; then
    { printf '\n## Repo-specific guidance\n\n'; cat "$HERDR_CATS_BRIEF_GUIDANCE"; } >>"$mem/brief.md"
  fi
  log_info "$key: brief materialized at $mem/brief.md"
}

# True if a specific pane currently hosts an agent.
worker_pane_alive() {
  local pane
  pane="$1"
  [[ -n "$pane" && "$pane" != "null" ]] || return 1
  "$HERDR_CATS_HERDR_BIN" agent list 2>/dev/null \
    | jq -e --arg p "$pane" '(.result.agents // []) | any(.pane_id == $p)' >/dev/null 2>&1
}

# Status of the agent in a specific pane: working|idle|done|blocked|... or gone.
worker_pane_state() {
  local pane
  pane="$1"
  [[ -n "$pane" && "$pane" != "null" ]] || { printf 'gone\n'; return; }
  "$HERDR_CATS_HERDR_BIN" agent list 2>/dev/null \
    | jq -r --arg p "$pane" '((.result.agents // []) | map(select(.pane_id == $p)) | .[0].agent_status) // "gone"' \
    2>/dev/null || printf 'unknown\n'
}

worker_pane_has_claude() {
  local pane
  pane="$1"
  [[ -n "$pane" && "$pane" != "null" ]] || return 1
  "$HERDR_CATS_HERDR_BIN" agent list 2>/dev/null \
    | jq -e --arg p "$pane" '(.result.agents // []) | any(.pane_id == $p and .agent == "claude")' >/dev/null 2>&1
}

# Resolve the layout's tab=main / pane=agent pane id (empty if not present yet).
worker_target_pane() {
  local wid
  local main_tab
  wid="$1"
  main_tab="$("$HERDR_CATS_HERDR_BIN" tab list --workspace "$wid" 2>/dev/null \
    | jq -r --arg l "$HERDR_CATS_MAIN_TAB" '((.result.tabs // .tabs // [])[] | select(.label == $l) | .tab_id) // empty' | head -1)"
  [[ -z "$main_tab" ]] && return 0
  "$HERDR_CATS_HERDR_BIN" pane list --workspace "$wid" 2>/dev/null \
    | jq -r --arg t "$main_tab" --arg l "$HERDR_CATS_AGENT_PANE" \
        '((.result.panes // .panes // [])[] | select(.tab_id == $t and .label == $l) | .pane_id) // empty' | head -1
}

# The worker-done handshake file (written by the worker when fully finished).
worker_done_marker() { printf '%s/.memory/herdr-cats/worker-done\n' "$1"; }
worker_is_done() {
  local worktree
  worktree="$(ledger_get "$1" worktree_path)"
  [[ -n "$worktree" && -f "$(worker_done_marker "$worktree")" ]]
}

# Type a single prompt into a live agent pane and submit it.
_worker_send_prompt() {
  local pane
  local prompt
  pane="$1"
  prompt="$2"
  "$HERDR_CATS_HERDR_BIN" agent send "$pane" "$prompt" >/dev/null 2>&1 || return 1
  "$HERDR_CATS_HERDR_BIN" pane send-keys "$pane" Enter >/dev/null 2>&1 || true
}

# Dispatch the worker into the layout's agent pane. Idempotent: no-op if its
# tracked pane is still live. Waits for the layout to apply, then sends the brief
# to the claude the layout starts there (falling back to a new pane if absent).
worker_spawn() {
  local key
  local wid
  local worktree
  local pane
  local target
  local waited
  key="$1"
  wid="$(ledger_get "$key" workspace_id)"
  worktree="$(ledger_get "$key" worktree_path)"
  pane="$(ledger_get "$key" pane_id)"

  if [[ -n "$pane" ]] && worker_pane_alive "$pane"; then
    log_info "$key: worker already running in $pane"
    return 0
  fi

  worker_materialize_brief "$key" "$worktree"

  # Wait for the layout's main/agent pane (its claude boots a little after the
  # worktree is created).
  target=""
  waited=0
  while (( waited < HERDR_CATS_LAYOUT_WAIT )); do
    target="$(worker_target_pane "$wid")"
    [[ -n "$target" ]] && worker_pane_has_claude "$target" && break
    sleep 4
    waited=$(( waited + 4 ))
  done

  if [[ -n "$target" ]]; then
    if worker_pane_has_claude "$target"; then
      sleep 2 # settle so the first keystrokes are not dropped
      _worker_send_prompt "$target" "$HERDR_CATS_WORKER_PROMPT" || { log_error "$key: failed to send brief to $target"; return 1; }
      log_info "$key: dispatched brief to layout agent pane $target"
    else
      # Agent pane exists but the layout didn't start claude — start it there.
      "$HERDR_CATS_HERDR_BIN" pane run "$target" \
        "$HERDR_CATS_CLAUDE_CMD $HERDR_CATS_CLAUDE_FLAGS \"$HERDR_CATS_WORKER_PROMPT\"" >/dev/null 2>&1 \
        || { log_error "$key: failed to start claude in $target"; return 1; }
      log_info "$key: started worker in layout agent pane $target"
    fi
    ledger_set "$key" pane_id "$target"
    "$HERDR_CATS_HERDR_BIN" agent rename "$target" "cat:$key" >/dev/null 2>&1 || true
    return 0
  fi

  # Fallback: layout's agent pane never appeared — open our own pane.
  log_warn "$key: layout agent pane ($HERDR_CATS_MAIN_TAB/$HERDR_CATS_AGENT_PANE) not found; opening a dedicated pane"
  # CLAUDE_FLAGS is an intentional word list; first token after -- is the exe.
  # shellcheck disable=SC2086
  target="$("$HERDR_CATS_HERDR_BIN" agent start claude \
    --workspace "$wid" --cwd "$worktree" --no-focus --env "HERDR_CATS_TICKET=$key" \
    -- "$HERDR_CATS_CLAUDE_CMD" $HERDR_CATS_CLAUDE_FLAGS "$HERDR_CATS_WORKER_PROMPT" 2>/dev/null \
    | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  if [[ -z "$target" ]]; then
    log_error "$key: failed to spawn worker"
    return 1
  fi
  ledger_set "$key" pane_id "$target"
  "$HERDR_CATS_HERDR_BIN" agent rename "$target" "cat:$key" >/dev/null 2>&1 || true
  log_info "$key: worker spawned in dedicated pane $target"
}
