# Releasing

herdr-factory has **no release tooling** — a release is just a **git tag**. This is the whole
process, and it's what the `stable` update channel follows.

## Update channels

Every installed box picks up new code automatically (the supervised auto-updater, on by default —
see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12). Which commit it lands on depends on its
channel, set at install time via `HERDR_CHANNEL`:

- **`main`** (default) — tracks the branch upstream (`origin/main`). New code reaches the box within
  ~a minute of a push. This is the historical behavior.
- **`stable`** — follows the newest **release tag**. A box on `stable` hard-resets to the latest
  `vX.Y.Z` tag and stays there until a newer tag exists, so a broken `main` commit never reaches it.

Change a box's channel by re-running the installer with the variable set:

```sh
HERDR_CHANNEL=stable curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | sh
# or, on an already-installed box:
HERDR_CHANNEL=stable herdr-factory install
```

(The value is captured into the launchd/systemd service environment at install time, exactly like
`HERDR_FACTORY_AUTO_UPDATE` — changing the shell variable alone does nothing until you re-run
`install`.)

## Cutting a release (making a new `stable`)

1. Get the commit you want to bless onto `main` (merged + green).
2. Tag it and push the tag:

   ```sh
   git tag v1.4.0        # semver, optional leading "v"; NO pre-release suffix
   git push origin v1.4.0
   ```

That's it. Within a tick (~60s) every `stable` box fetches tags and hard-resets to `v1.4.0`.

### Tagging rules the updater relies on

- **Semver only.** The updater picks the highest tag matching `vX.Y.Z` (or `X.Y.Z`), compared
  **numerically** by (major, minor, patch) — so `v1.10.0` correctly beats `v1.9.0`.
- **No pre-releases.** A tag like `v1.4.0-rc1` is **ignored** — `stable` follows finished releases
  only. Cut the plain `v1.4.0` tag when it's ready.
- **Don't move a tag** you've already pushed. `stable` boxes reset to the tag's commit; re-pointing a
  published tag would silently move every stable box. Cut a new tag instead.

## Verifying

`herdr-factory doctor` shows each box's channel and its last update outcome under **auto-update** —
including an amber line when an update failed, was skipped for a dirty checkout, or the box is behind
its channel target. The same line renders in the TUI's Doctor tab.
