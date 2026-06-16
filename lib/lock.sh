#!/bin/bash
# Portable locking. macOS has no flock(1), so locks are atomic `mkdir` dirs.
# Two flavours, because the holders differ:
#
#   pidlock_*  — holder is a long-lived process that stays alive while it holds
#                the lock (the tick reconciler). Staleness = holder PID dead.
#                Used for single-instance enforcement.
#
#   ttllock_*  — holder is ephemeral: acquire and release run as SEPARATE
#                short-lived commands (a worker agent brackets its dev-server
#                capture with `capture-lock acquire` … `capture-lock release`).
#                PID liveness is useless here, so staleness = age > ttl.
#                Used for the global screenshot-capture lock.

set -euo pipefail

_lock_path() { printf '%s/%s.lock\n' "$HERDR_CATS_LOCKS_DIR" "$1"; }

# --- PID lock (single-instance) --------------------------------------------

pidlock_acquire() {
  local name
  local dir
  local owner
  name="$1"
  dir="$(_lock_path "$name")"
  mkdir -p "$HERDR_CATS_LOCKS_DIR"

  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$dir/pid"
    return 0
  fi

  owner="$(cat "$dir/pid" 2>/dev/null || printf '')"
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    return 1 # held by a live process
  fi

  # Stale (holder died). Steal it.
  rm -rf "$dir"
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$dir/pid"
    return 0
  fi
  return 1
}

pidlock_release() {
  local name
  local dir
  name="$1"
  dir="$(_lock_path "$name")"
  if [[ "$(cat "$dir/pid" 2>/dev/null || printf '')" == "$$" ]]; then
    rm -rf "$dir"
  fi
}

# --- TTL lock (ephemeral acquire/release across processes) ------------------

ttllock_acquire() {
  local name
  local owner
  local ttl
  local dir
  local since
  local now
  name="$1"
  owner="$2"
  ttl="$3"
  dir="$(_lock_path "$name")"
  mkdir -p "$HERDR_CATS_LOCKS_DIR"

  if mkdir "$dir" 2>/dev/null; then
    printf '%s %s\n' "$owner" "$(date +%s)" >"$dir/owner"
    return 0
  fi

  since="$(awk '{print $2}' "$dir/owner" 2>/dev/null || printf '0')"
  now="$(date +%s)"
  if [[ -n "$since" ]] && (( now - since > ttl )); then
    rm -rf "$dir" # expired — steal
    if mkdir "$dir" 2>/dev/null; then
      printf '%s %s\n' "$owner" "$now" >"$dir/owner"
      return 0
    fi
  fi
  return 1
}

ttllock_acquire_blocking() {
  local name
  local owner
  local ttl
  local wait_s
  local poll
  local waited
  name="$1"
  owner="$2"
  ttl="$3"
  wait_s="${4:-1200}"
  poll="${5:-5}"
  waited=0
  while ! ttllock_acquire "$name" "$owner" "$ttl"; do
    if (( waited >= wait_s )); then
      return 1
    fi
    sleep "$poll"
    waited=$(( waited + poll ))
  done
  return 0
}

ttllock_release() {
  local name
  local owner
  local dir
  name="$1"
  owner="$2"
  dir="$(_lock_path "$name")"
  if [[ "$(awk '{print $1}' "$dir/owner" 2>/dev/null || printf '')" == "$owner" ]]; then
    rm -rf "$dir"
  fi
}
