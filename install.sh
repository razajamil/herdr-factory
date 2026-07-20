#!/usr/bin/env bash
# herdr-factory installer — bootstraps a bare machine with ZERO pre-installed runtime:
#
#   curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | sh
#
# POSIX sh — runs under dash (Debian/Ubuntu /bin/sh), busybox ash (Alpine) and bash (macOS), so
# `| sh` works on every supported target. What it does (idempotent — safe to re-run to repair/upgrade):
#   1. detects OS / arch / libc,
#   2. (optional) seeds a read-only deploy key + ssh config so it can clone the private repo,
#   3. clones (or updates) the code checkout,
#   4. downloads + SHA-256-verifies the pinned official Node (from .node-version) into
#      <state>/runtime/<ver> and points a stable `current` symlink at it — no system Node needed,
#   5. installs pnpm (via the vendored Node) and runs `pnpm install` (resolves opentui's native
#      per-platform binary AND the @aws-sdk deps — so evidence upload needs no `aws` CLI),
#   6. drops `herdr-factory` / `herdr-factory-tui` shims on PATH,
#   7. registers this checkout as a herdr plugin (the layout hook — so each new worktree of a
#      managed repo gets its per-belt herdr layout built automatically),
#   8. installs the machine-wide supervisor service (launchd on macOS, systemd --user on Linux).
#
# After install, the app self-updates: a git pull that bumps .node-version re-provisions Node, and a
# lockfile change re-runs pnpm install — automatically, on the supervisor tick. Set HERDR_CHANNEL=stable
# to follow the latest release tag instead of tip-of-main (captured into the service env; see RELEASING.md).
#
# Prerequisites: git, curl, tar (self-update is git-based). Everything else — Node, SQLite (built
# into Node), pnpm, the AWS SDK — is provided here. On MINIMAL Linux images the vendored Node also
# links a couple of system libs the base image may omit (Debian/arm64: libatomic1; Alpine/musl:
# libstdc++), and the launcher shims need bash — the installer verifies the Node it downloaded can
# start and, if not, tells you exactly which package to add.
#
# Uninstall:  curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | sh -s -- --uninstall
set -eu

# ── Configuration (override via env) ──────────────────────────────────────────────────────────
STATE_ROOT="${HERDR_FACTORY_STATE_ROOT:-$HOME/.local/state/herdr-factory}"
APP_DIR="${HERDR_APP_DIR:-$HOME/.local/share/herdr-factory}"
BIN_DIR="${HERDR_BIN_DIR:-$HOME/.local/bin}"
REPO_URL="${HERDR_REPO_URL:-https://github.com/razajamil/herdr-factory.git}"
BRANCH="${HERDR_BRANCH:-main}"
PNPM_VERSION="${HERDR_PNPM_VERSION:-11}"
DEPLOY_KEY="${HERDR_DEPLOY_KEY:-}"   # literal key content OR a path to a key file (optional)
SSH_HOST="${HERDR_SSH_HOST:-}"       # real hostname behind the repo's Host alias (optional)
SKIP_SERVICE="${HERDR_SKIP_SERVICE:-}"

RUNTIME_ROOT="$STATE_ROOT/runtime"
CURRENT_LINK="$RUNTIME_ROOT/current"
NODE_PATH_FILE="$STATE_ROOT/node-path"
OS="" ; ARCH="" ; LIBC="" ; SHA256=""

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight: the three irreducible tools ─────────────────────────────────────────────────────
require_tools() {
  missing=""
  for t in git curl tar; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  if command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"
  else missing="$missing shasum/sha256sum"; fi
  if [ -n "$missing" ]; then
    die "missing required tool(s):${missing}. Install them and re-run (macOS: xcode-select --install; Debian: apt-get install git curl tar; Alpine: apk add git curl tar)."
  fi
}

# ── Platform detection (mirror src/watchers/provision.ts) ──────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux)  OS=linux ;;
    *) die "unsupported OS: $(uname -s) (macOS + Linux only; Windows is a separate installer)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "unsupported arch: $(uname -m) (x64 + arm64 only)" ;;
  esac
  if [ "$OS" = linux ]; then
    if { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; } \
       || ls /lib/ld-musl-* >/dev/null 2>&1; then
      LIBC=musl
    else
      LIBC=glibc
    fi
  fi
}

# ── Deploy key + ssh config (only if a key was provided) ───────────────────────────────────────
seed_deploy_key() {
  [ -n "$DEPLOY_KEY" ] || return 0
  ssh_dir="$HOME/.ssh" ; key_file="$HOME/.ssh/herdr-factory_deploy"
  mkdir -p "$ssh_dir" ; chmod 700 "$ssh_dir"
  if [ -f "$DEPLOY_KEY" ]; then cp "$DEPLOY_KEY" "$key_file"; else printf '%s\n' "$DEPLOY_KEY" > "$key_file"; fi
  chmod 600 "$key_file"
  # Parse the host from git@HOST:path (or ssh://git@HOST/path).
  host="$(printf '%s' "$REPO_URL" | sed -E 's#^ssh://##; s#^[^@]*@##; s#[:/].*$##')"
  [ -n "$host" ] || { warn "could not parse host from $REPO_URL — skipping ssh config"; return 0; }
  cfg="$ssh_dir/config"
  touch "$cfg" ; chmod 600 "$cfg"
  # Exact-field match (not a regex — a hostname's dots must not act as wildcards) for idempotency.
  if ! awk -v h="$host" '$1=="Host"{for(i=2;i<=NF;i++) if($i==h) f=1} END{exit f?0:1}' "$cfg" 2>/dev/null; then
    {
      echo ""
      echo "# added by herdr-factory install.sh"
      echo "Host $host"
      [ -n "$SSH_HOST" ] && echo "  HostName $SSH_HOST"
      echo "  User git"
      echo "  IdentityFile $key_file"
      echo "  IdentitiesOnly yes"
    } >> "$cfg"
    say "wrote ssh config block for '$host'"
  fi
}

# ── Clone or update the code checkout ──────────────────────────────────────────────────────────
sync_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    say "updating existing checkout at $APP_DIR"
    git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
  else
    say "cloning $REPO_URL → $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
      || die "git clone failed. If this is a private repo, provide a deploy key: HERDR_DEPLOY_KEY=~/key HERDR_SSH_HOST=<host> ... and ensure the remote host is reachable."
  fi
}

# ── Provision the pinned Node (mirror src/watchers/provision.ts) ───────────────────────────────
provision_node() {
  ver="$(tr -d ' \tv\n' < "$APP_DIR/.node-version")"
  case "$ver" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) die ".node-version must pin an exact x.y.z (got '$ver')" ;;
  esac
  vdir="$RUNTIME_ROOT/$ver" ; nodebin="$RUNTIME_ROOT/$ver/bin/node"
  if [ -x "$nodebin" ]; then verify_node "$nodebin"; say "Node $ver already provisioned"; link_current "$ver"; return 0; fi

  if [ "$LIBC" = musl ]; then
    dirname_="node-v$ver-linux-$ARCH-musl"
    base="https://unofficial-builds.nodejs.org/download/release/v$ver"
  else
    dirname_="node-v$ver-$OS-$ARCH"
    base="https://nodejs.org/dist/v$ver"
  fi
  file="$dirname_.tar.gz"
  sums_url="$base/SHASUMS256.txt"

  mkdir -p "$RUNTIME_ROOT"
  tarball="$RUNTIME_ROOT/.dl-$ver-$$.tar.gz"
  tmp="$RUNTIME_ROOT/.tmp-$ver-$$"
  # EXIT (not RETURN) trap: also fires on die()/set -e failures, so temp artifacts never leak.
  trap 'rm -rf "$tarball" "$tmp"' EXIT

  say "downloading Node $ver ($OS-$ARCH${LIBC:+ $LIBC}) from $base"
  curl -fSL --retry 3 -o "$tarball" "$base/$file" || die "download failed: $base/$file"

  expected="$(curl -fsSL "$sums_url" | awk -v f="$file" '$2==f || $2=="*"f {print $1}')" || true
  [ -n "$expected" ] || die "no SHASUMS256 entry for $file at $sums_url"
  actual="$($SHA256 "$tarball" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $file (expected $expected, got $actual)"
  say "checksum verified"

  rm -rf "$tmp" ; mkdir -p "$tmp"
  tar -xzf "$tarball" -C "$tmp" --strip-components=1
  [ -x "$tmp/bin/node" ] || die "extracted tarball has no bin/node"
  rm -rf "$vdir" ; mv "$tmp" "$vdir"
  verify_node "$vdir/bin/node"   # fail early + actionable if a system lib is missing
  link_current "$ver"
  say "Node $ver ready at $vdir"
}

# The vendored Node dynamically links a few system libs bare distros may omit (libatomic on arm64
# glibc; libgcc/libstdc++ on musl). Verify it actually starts and, if not, name the fix — far better
# than a cryptic loader crash deeper in the install (e.g. mid `pnpm install`).
verify_node() {
  node_out="$("$1" -v 2>&1)" && return 0
  printf '%s\n' "$node_out" | sed 's/^/    /' >&2
  case "$node_out" in
    *libatomic*) fix="install libatomic — Debian/Ubuntu: sudo apt-get install libatomic1 · Fedora/RHEL: sudo dnf install libatomic" ;;
    *libgcc*|*libstdc*) fix="install the C++ runtime — Alpine: sudo apk add libstdc++ · Debian/Ubuntu: sudo apt-get install libstdc++6" ;;
    *) fix="install the missing system library shown above" ;;
  esac
  die "the vendored Node ($1) could not start. Fix: $fix — then re-run install.sh."
}

# Point runtime/current at a version dir, and write the stable node-path the app + service read.
link_current() {
  ln -sfn "$RUNTIME_ROOT/$1" "$CURRENT_LINK"
  mkdir -p "$STATE_ROOT"
  printf '%s' "$CURRENT_LINK/bin/node" > "$NODE_PATH_FILE"
}

# ── pnpm + dependencies (via the vendored Node) ────────────────────────────────────────────────
install_deps() {
  node_bin_dir="$CURRENT_LINK/bin"
  export PATH="$node_bin_dir:$PATH"
  if [ ! -x "$node_bin_dir/pnpm" ]; then
    say "installing pnpm@$PNPM_VERSION (via the vendored Node)"
    "$node_bin_dir/npm" install -g "pnpm@$PNPM_VERSION" --silent --no-fund --no-audit
  fi
  say "installing dependencies (pnpm install)"
  ( cd "$APP_DIR" && "$node_bin_dir/pnpm" install --config.confirmModulesPurge=false )
}

# ── PATH shims ─────────────────────────────────────────────────────────────────────────────────
install_shims() {
  mkdir -p "$BIN_DIR"
  ln -sf "$APP_DIR/bin/herdr-factory" "$BIN_DIR/herdr-factory"
  ln -sf "$APP_DIR/bin/herdr-factory-tui" "$BIN_DIR/herdr-factory-tui"
  say "linked shims into $BIN_DIR"
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) warn "$BIN_DIR is not on your PATH — add it: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  # The launcher shims are bash scripts; a busybox-only box (Alpine) needs bash to run them.
  command -v bash >/dev/null 2>&1 || warn "the herdr-factory launchers need bash (not found) — install it (Alpine: sudo apk add bash)."
}

# ── herdr plugin (the layout hook) ─────────────────────────────────────────────────────────────
# Register this checkout as a herdr plugin so herdr fires worktree.created / workspace.created /
# workspace.focused at it, and the factory builds each new worktree's per-belt layout (see
# herdr-plugin.toml + src/core/layout-hook.ts). Best-effort: herdr is a runtime dependency but may
# not be on PATH at install time (e.g. a headless bootstrap), so its absence is a warning, not a
# failure. Idempotent — re-links only if not already pointing at this checkout.
install_plugin() {
  if ! command -v herdr >/dev/null 2>&1; then
    warn "herdr not on PATH — skipping plugin link. Layouts won't auto-apply until you run: herdr plugin link '$APP_DIR'"
    return 0
  fi
  linked_root="$(herdr plugin list --plugin herdr-factory --json 2>/dev/null | sed -n 's/.*"plugin_root":"\([^"]*\)".*/\1/p' | head -n1)"
  if [ "$linked_root" = "$APP_DIR" ]; then
    say "herdr plugin already linked ($APP_DIR)"
    return 0
  fi
  # A stale link at a different path (e.g. an old checkout) would collide on the plugin id — drop it.
  [ -n "$linked_root" ] && herdr plugin unlink herdr-factory >/dev/null 2>&1
  if herdr plugin link "$APP_DIR" >/dev/null 2>&1; then
    say "linked herdr plugin (layout hook)"
  else
    warn "herdr plugin link failed — register it manually: herdr plugin link '$APP_DIR'"
  fi
}

# ── Service (launchd / systemd) ────────────────────────────────────────────────────────────────
install_service() {
  [ -z "$SKIP_SERVICE" ] || { say "skipping service install (HERDR_SKIP_SERVICE set)"; return 0; }
  say "installing the supervisor service"
  # HERDR_FROM_INSTALLER suppresses the install command's own onboarding pointer: inside install.sh
  # the epilogue's `doctor` run prints the context-aware forward link, so we don't want a second one
  # buried mid-install (and a fresh-box doctor correctly says "fix your ✗ tools" rather than "init").
  HERDR_FROM_INSTALLER=1 "$BIN_DIR/herdr-factory" install
}

# ── Epilogue: the you-provide checklist + a live doctor run ─────────────────────────────────────
# install.sh bootstraps only what the factory itself needs (its Node runtime, pnpm, deps, shims,
# plugin, service). The tools the factory *drives* are yours to install and authenticate — the same
# ones you'd reach for by hand. Spell them out (with where to get each), mirroring the "you provide
# (install + auth)" group in src/doctor.ts, so a fresh box knows exactly what's still on the operator.
you_provide_checklist() {
  echo ""
  say "you provide these — install + authenticate them yourself:"
  echo "  • herdr        worktrees · workspaces · panes · agent lifecycle   → https://herdr.dev"
  echo "  • an agent CLI the workers: claude · opencode · pi · codex · …  (panes default to 'claude')"
  echo "  • gh           PR discovery + CI/review polling — then run: gh auth login"
  echo "  • git          branch cleanup + heartbeats (usually already present)"
}

# Run doctor so the operator sees, right now, what's ready (✓) vs still missing (✗) — the same
# command the README says to run any time. Two guards: the bash shim can't run without bash (already
# warned in install_shims), and doctor exits non-zero when any check fails — expected on a fresh box
# that hasn't got herdr/gh/claude yet — so `|| true` keeps `set -e` from aborting at the finish line.
run_doctor() {
  [ -x "$BIN_DIR/herdr-factory" ] && command -v bash >/dev/null 2>&1 || return 0
  echo ""
  say "doctor — a health check of the setup (✓ ready · ✗ needs your attention):"
  "$BIN_DIR/herdr-factory" doctor || true
}

# ── Uninstall (needs none of git/curl/tar — do NOT run require_tools here) ──────────────────────
uninstall() {
  say "uninstalling herdr-factory"
  if [ -x "$BIN_DIR/herdr-factory" ]; then "$BIN_DIR/herdr-factory" uninstall || warn "service uninstall reported an error"; fi
  command -v herdr >/dev/null 2>&1 && herdr plugin unlink herdr-factory >/dev/null 2>&1
  rm -f "$BIN_DIR/herdr-factory" "$BIN_DIR/herdr-factory-tui"
  rm -rf "$RUNTIME_ROOT"
  say "removed shims + vendored Node runtime."
  warn "left in place (contains your data): $APP_DIR (code) and $STATE_ROOT (DB, config)."
  warn "to remove them too: rm -rf '$APP_DIR' '$STATE_ROOT'"
}

main() {
  if [ "${1:-}" = "--uninstall" ]; then uninstall; return 0; fi
  require_tools
  detect_platform
  say "platform: $OS-$ARCH${LIBC:+ ($LIBC)}"
  seed_deploy_key
  sync_repo
  provision_node
  install_deps
  install_shims
  install_plugin
  install_service
  echo ""
  say "herdr-factory installed."
  echo "  • CLI:  herdr-factory --help"
  echo "  • TUI:  herdr-factory            (no args launches the TUI)"
  echo "  • The supervisor keeps the server up and auto-updates from $BRANCH."
  echo "  • Layouts: a repo's belts can build a herdr tab/pane layout into each new worktree (herdr plugin — see README)."
  you_provide_checklist
  run_doctor
}

main "$@"
