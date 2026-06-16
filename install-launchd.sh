#!/bin/bash
# Install/remove the per-repo launchd job that fires `herdr-cats --repo <name>
# tick` on an interval. Invoked by `herdr-cats --repo <name> install` (which
# exports HERDR_CATS_HOME + HERDR_CATS_REPO).
#
# Notes:
#  - launchd jobs run with a bare environment, so we bake the CURRENT $PATH into
#    the plist. Run install from your normal interactive shell (where mise/herdr/
#    gh resolve) so the captured PATH works.
#  - Secrets are NOT written to the plist: the tick re-sources the env + repo
#    config each run.
#  - launchd won't run two copies of the same job concurrently (backs up the
#    tick's pidlock). Stopping a job never touches in-flight workers.

set -euo pipefail

HERDR_CATS_HOME="${HERDR_CATS_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
export HERDR_CATS_HOME
# shellcheck source=/dev/null
source "$HERDR_CATS_HOME/lib/config.sh"

[[ -n "$HERDR_CATS_REPO" ]] || { printf 'Error: HERDR_CATS_REPO not set (use: herdr-cats --repo <name> install)\n' >&2; exit 1; }

DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$HERDR_CATS_LAUNCHD_LABEL"

write_plist() {
  mkdir -p "$(dirname "$HERDR_CATS_LAUNCHD_PLIST")" "$HERDR_CATS_LOGS_DIR"
  cat >"$HERDR_CATS_LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$HERDR_CATS_LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HERDR_CATS_HOME/bin/herdr-cats</string>
    <string>--repo</string>
    <string>$HERDR_CATS_REPO</string>
    <string>tick</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartInterval</key><integer>$HERDR_CATS_TICK_INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HERDR_CATS_LOGS_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HERDR_CATS_LOGS_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST
  printf 'wrote %s\n' "$HERDR_CATS_LAUNCHD_PLIST"
}

boot_out()   { launchctl bootout "$TARGET" 2>/dev/null || true; }
boot_strap() { launchctl bootstrap "$DOMAIN" "$HERDR_CATS_LAUNCHD_PLIST"; }

case "${1:-}" in
  install)
    write_plist; boot_out; boot_strap
    printf 'installed + loaded %s (every %ss)\n' "$HERDR_CATS_LAUNCHD_LABEL" "$HERDR_CATS_TICK_INTERVAL"
    ;;
  uninstall)
    boot_out; rm -f "$HERDR_CATS_LAUNCHD_PLIST"
    printf 'uninstalled %s (in-flight workers untouched)\n' "$HERDR_CATS_LAUNCHD_LABEL"
    ;;
  start)
    [[ -f "$HERDR_CATS_LAUNCHD_PLIST" ]] || write_plist
    boot_out; boot_strap
    printf 'started %s\n' "$HERDR_CATS_LAUNCHD_LABEL"
    ;;
  stop)
    boot_out
    printf 'stopped %s (in-flight workers keep running)\n' "$HERDR_CATS_LAUNCHD_LABEL"
    ;;
  *)
    printf 'usage: install-launchd.sh install|uninstall|start|stop\n' >&2
    exit 1
    ;;
esac
