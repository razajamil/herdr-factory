#!/bin/bash
# Logging helpers. Source after config.sh.
# Every line goes to stderr and to a per-day log file under the state dir,
# so a launchd-driven run leaves an inspectable trail.

set -euo pipefail

log_init() {
  mkdir -p "$HERDR_CATS_LOGS_DIR"
}

_log_line() {
  local level
  local msg
  local ts
  level="$1"
  msg="$2"
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf '%s [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$HERDR_CATS_LOGS_DIR/$(date '+%Y-%m-%d').log" >&2
}

log_info()  { _log_line "INFO"  "$1"; }
log_warn()  { _log_line "WARN"  "$1"; }
log_error() { _log_line "ERROR" "$1"; }

# Surface a desktop notification for things a human should look at. Best-effort:
# never let a notification failure abort the tick.
log_notify() {
  local title
  local body
  title="$1"
  body="${2:-}"
  log_warn "NOTIFY: $title — $body"
  "$HERDR_CATS_HERDR_BIN" notification show "$title" --body "$body" --sound request >/dev/null 2>&1 || true
}
