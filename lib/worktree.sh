#!/bin/bash
# Worktree + branch lifecycle via the herdr CLI. Source after config/log/ledger.
# Every operation is idempotent so a tick that crashed mid-create can re-run.

set -euo pipefail

# Map a Jira issue type to a branch prefix (fix/chore/feature). Substring match
# so "Dev bug", "Sub-task", etc. classify correctly.
worktree_prefix_for_type() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *bug*|*defect*)      printf 'fix' ;;
    *chore*|*task*)      printf 'chore' ;;
    *)                   printf 'feature' ;;
  esac
}

# fix/RWR-1234-short-kebab-summary  (slug from summary, capped).
worktree_branch_name() {
  local key
  local type
  local summary
  local prefix
  local slug
  key="$1"
  type="$2"
  summary="$3"
  prefix="$(worktree_prefix_for_type "$type")"
  slug="$(printf '%s' "$summary" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9' '-' \
    | tr -s '-' \
    | sed -E 's/^-+//; s/-+$//' \
    | cut -c1-50 \
    | sed -E 's/-+$//')"
  [[ -z "$slug" ]] && slug="work"
  printf '%s/%s-%s\n' "$prefix" "$key" "$slug"
}

# Create (or re-attach to) the worktree for a branch. Idempotent: if the branch
# already has a worktree it is opened rather than re-created. Echoes compact JSON
# {workspace_id, worktree_path, pane_id}.
worktree_create() {
  local branch
  local out
  branch="$1"

  # If a worktree for this branch already exists, open it instead of creating.
  if git -C "$HERDR_CATS_REPO_CWD" show-ref --verify --quiet "refs/heads/$branch"; then
    out="$("$HERDR_CATS_HERDR_BIN" worktree open --cwd "$HERDR_CATS_REPO_CWD" --branch "$branch" --no-focus --json 2>/dev/null || true)"
  else
    out="$("$HERDR_CATS_HERDR_BIN" worktree create --cwd "$HERDR_CATS_REPO_CWD" --branch "$branch" --base "$HERDR_CATS_BASE_REF" --no-focus --json 2>/dev/null || true)"
  fi

  if [[ -z "$out" ]]; then
    log_error "worktree create/open failed for branch $branch"
    return 1
  fi

  # Shape: .result.{workspace.workspace_id, workspace.worktree.checkout_path, root_pane.pane_id}
  printf '%s' "$out" | jq -c '{
    workspace_id: (.result.workspace.workspace_id // .workspace.workspace_id // .result.root_pane.workspace_id // null),
    worktree_path: (.result.workspace.worktree.checkout_path // .result.root_pane.cwd // .workspace.worktree.checkout_path // null),
    pane_id: (.result.root_pane.pane_id // .root_pane.pane_id // null)
  }'
}

# Resolve the root pane of a workspace (worktree.created omits it; query live).
worktree_root_pane() {
  local workspace_id
  workspace_id="$1"
  "$HERDR_CATS_HERDR_BIN" pane list --workspace "$workspace_id" 2>/dev/null \
    | jq -r '(.panes // .result.panes // [])[0].pane_id // empty' 2>/dev/null
}

worktree_workspace_alive() {
  local workspace_id
  workspace_id="$1"
  [[ -n "$workspace_id" ]] || return 1
  "$HERDR_CATS_HERDR_BIN" workspace get "$workspace_id" >/dev/null 2>&1
}

# Fully remove a ticket's worktree: close the herdr workspace, then clean up
# what herdr leaves behind — the checkout directory, the git worktree
# registration, and the orphaned local branch — so the same branch can be
# re-claimed cleanly later. Idempotent: every missing piece is fine.
worktree_teardown() {
  local workspace_id
  local branch
  local path
  workspace_id="$1"
  branch="${2:-}"
  path="${3:-}"

  if [[ -n "$workspace_id" && "$workspace_id" != "null" ]]; then
    "$HERDR_CATS_HERDR_BIN" worktree remove --workspace "$workspace_id" --force --json >/dev/null 2>&1 || true
    "$HERDR_CATS_HERDR_BIN" workspace close "$workspace_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$path" && "$path" != "null" && -d "$path" ]]; then
    rm -rf "$path"
  fi
  git -C "$HERDR_CATS_REPO_CWD" worktree prune >/dev/null 2>&1 || true
  if [[ -n "$branch" && "$branch" != "null" ]]; then
    git -C "$HERDR_CATS_REPO_CWD" branch -D "$branch" >/dev/null 2>&1 || true
  fi
  log_info "tore down workspace ${workspace_id:-?} (branch ${branch:-?})"
}
