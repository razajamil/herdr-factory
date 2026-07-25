# Layouts

How the factory builds a herdr tab/pane arrangement into each new worktree, how a step targets a pane in it, and every way that can fail.

Answers these questions:

- Do I need a `layouts:` block at all, or will steps just spawn their own panes?
- What are the legal keys/values under `layouts[]` — split directions, `size`, `ratio`, `setup`?
- How does a step's `tab`/`pane` resolve to a real herdr pane, and why does it sometimes never resolve?
- Which layout does a given worktree get — `default_layout` or a `layout_matching` glob?
- Why was no layout built at all? (Almost always: the herdr plugin isn't linked.)
- How do I force a layout to be rebuilt into an existing worktree?
- How long does a step wait for its pane before parking, and what happens then?

---

## Do you need a layout?

**No, by default.** Omit `layouts` (and every belt's `default_layout` / `layout_matching`) and each step spawns its own dedicated pane via `herdr agent start` using the resolved `agent:` harness. Zero setup, no plugin link needed, works fine.

You need a layout when:

| reason | detail |
|---|---|
| A step must run in a pane **you** control | e.g. an agent pane sitting beside a long-running `pnpm dev` pane in the same tab, so the agent can see the server's output. |
| You use an `evidence` step | `evidence` declares `posture.requiresLayout` (`src/steps/evidence/descriptor.ts`). With no `tab`+`pane` it is **silently SKIPPED**, never spawned. The TUI warns inline: `↳ no tab/pane ⇒ this <type> step is SKIPPED (it only runs in a layout pane)`. |
| A layout-level `setup` command must run before work starts | e.g. `pnpm install` in the fresh worktree, `blocking: true`. |
| A human watches the worktree and wants a fixed window shape | tab/pane titles are stable and addressable. |

The cost: a layout only exists if the **herdr plugin hook** is linked and fires (see [The build mechanism](#the-build-mechanism--the-herdr-plugin-hook)). No link ⇒ no layout ⇒ every `tab`/`pane` step burns its wait budget and parks.

---

## The `layouts:` schema

Repo-level array, `default([])`. Every object is `.strict()` — an unknown or misspelled key is a load error.

```yaml
layouts:
  - id: app-dev
    setup:
      command: pnpm install --frozen-lockfile
      blocking: true
    tabs:
      - title: work
        panes:
          - title: agent
            command: claude --dangerously-skip-permissions
            setup: true
          - title: server
            command: pnpm dev
            split: down
            size: "35%"
```

| key | type | default | notes |
|---|---|---|---|
| `id` | string, trimmed, min 1 | **required** | Unique across `layouts`; what a belt's `default_layout`/`layout_matching` references. |
| `setup.command` | string, trimmed, min 1 | **required inside `setup`** | Runs once, in the single `setup: true` pane, **before** that pane's own `command`. |
| `setup.blocking` | bool | `false` | The builder waits for it (cap `SETUP_TIMEOUT_MS` = 600 s) before spawning any later tab/pane. |
| `tabs[]` | array | **required**, min 1 | `a layout needs at least one tab` |
| `tabs[].title` | string, trimmed, min 1 | *optional* | The herdr tab label. **Untitled ⇒ unaddressable by a step.** |
| `tabs[].panes[]` | array | **required**, min 1 | `a tab needs at least one pane` |
| `panes[].title` | string, trimmed, min 1 | *optional* | The herdr pane label — what a step's `pane` matches. **Untitled ⇒ unaddressable.** |
| `panes[].command` | string, trimmed, min 1 | *optional* | Shell command run in the pane once it's built. |
| `panes[].setup` | bool | `false` | Marks **the** pane the layout-level `setup.command` runs in. At most one per layout. |
| `panes[].split` | `vertical` \| `horizontal` \| `right` \| `down` | `right` | How this pane splits off the **previous** pane. **Ignored on pane 0** (it is the tab's root pane). |
| `panes[].size` | `"NN%"` string or number > 0 | — | This pane's **own** extent along the split axis. Mutually exclusive with `ratio`. |
| `panes[].ratio` | number, `0 < n < 1` | — | Legacy/undocumented: the fraction the **PREVIOUS** pane keeps. Passes straight through to herdr. |

Split normalization: `vertical`/`right` → a new pane to the **right**; `horizontal`/`down` → **below**.

`size` forms (`normalizeSize`, `src/config.ts`):

| written | means |
|---|---|
| `"30%"` | 30% of the parent along the split axis. Must satisfy `0 < pct < 100`. |
| `0.3` | Same as `"30%"` — a number `< 1` is read as a fraction. |
| `40` | 40 terminal cells. Numbers `>= 1` must be whole. |

**`size` sizes the NEW pane; herdr's `--ratio` sizes the FROM pane** — the runner inverts it, so `size: "30%"` becomes `herdr pane split --ratio 0.7`, clamped to `[0.01, 0.99]`. A **cells** size needs the from-pane's live extent (`herdr pane layout --pane <id>`); when that can't be read the split gets **no ratio at all** (herdr's default split), silently.

### Layout-specific load errors

| error text | cause |
|---|---|
| `set either ratio or size, not both` (path `size`) | both set on one pane |
| `at most one pane in a layout may set \`setup: true\`` (path `tabs`) | two `setup: true` panes |
| `a layout with a \`setup\` block needs one pane marked \`setup: true\` to run it in` (path `setup`) | `setup:` present, no pane marked |
| `duplicate layout id "<id>" — layout ids must be unique` | two layouts share an `id` |
| `layout "<id>": size "<raw>" must be a percentage between 0% and 100%` | `"0%"`, `"120%"` |
| `layout "<id>": a fixed pane size (<n>) must be a whole number of cells` | `size: 40.5` |
| `belt "<b>" default_layout "<x>" is not a defined layout (defined: …)` | unknown id |
| `belt "<b>" layout_matching[<j>] references unknown layout "<x>" (defined: …)` | unknown id in a rule |

The complete load-time rejection catalogue is in [config-reference.md](./config-reference.md).

### What the builder actually issues

Depth-first walk (`buildPlan`, `src/core/layout.ts`): tab 0 **renames the worktree's existing root tab**; tabs 1..n are `herdr tab create --no-focus` (so building never steals focus). Within a tab, pane 0 **is** the tab's root pane; panes 1..n `herdr pane split` from the **previous** pane. Then per pane, in order: rename → layout `setup` (if this is the setup pane) → the pane's own `command`. New tabs/panes open with `--cwd` = the worktree checkout. A 700 ms settle precedes the first write to any pane. A blocking setup's non-zero exit only logs `layout "<id>": setup command exited <code> in <paneId>` — it never fails the apply.

Because the walk is depth-first and a blocking setup pauses it, putting `setup: true` on the **first** pane of the **first** tab guarantees nothing else spawns until setup finishes.

---

## Step → pane targeting

```yaml
steps:
  - { type: work, tab: work, pane: agent }
```

- `tab` and `pane` are **both-or-neither**: `tab and pane must be set together (or both omitted to spawn a dedicated pane)` (reported at path `pane`).
- They match **herdr labels by exact string equality** — the layout's `tabs[].title` and `panes[].title`. No trimming, no case folding, no fuzzy match. A trailing space or a different emoji is a permanent miss.
- **Untitled tabs/panes cannot be targeted.** The loader's target set only contains titled tab × titled pane pairs.
- **Two steps of one belt may not target the same pane**: `belt "<b>" steps "<a>" and "<b>" target the same layout pane (tab "<t>", pane "<p>") — each step needs its own agent pane`. Reason: the first dispatch renames the pane to `<step>:<KEY>`, so the second step's label lookup could never resolve. **Two different belts may reuse the same titles** — a worktree only ever runs one belt.
- **Validated at load, but only against the belt's `default_layout`.** A belt with no `default_layout` is skipped (its panes come from outside the factory), and `layout_matching` targets are deliberately **exempt** (those rules commonly serve hand-created worktrees). So a target that exists only in a `layout_matching` layout fails at **runtime** as a layout-wait park, not at save. Load error when it does fire:
  `belt "<b>" step "<name>" targets pane <tab>/<pane>, but layout "<L>" does not define it — its labeled panes are: <tab/pane, …>. Fix the step's tab/pane, or add a pane titled "<pane>" to a tab titled "<tab>" in the layout.`

**Dispatch-time resolution** (`dispatchToLayoutImpl`, `src/core/step.ts`), in order:

1. the pane id recorded for this step, if `herdr agent list` still shows it alive (a re-entry's durable handle);
2. `tab list` label == `tab` → `pane list` label == `pane` (a **first** entry);
3. the same lookup against the renamed label `<step>:<KEY>` (a re-entry whose recorded id was lost).

Then: no target → wait. A **fresh** target whose state isn't `idle` → wait. A reused target that is `working` → wait (never interleave two conversations in one pane). Otherwise: 2 s settle (fresh only), `herdr agent prompt`, `Enter`, rename to `<step>:<KEY>`.

**The targeted pane's `command` must be a herdr-integrated agent harness.** Pane state is whatever `herdr agent list` reports as `agent_status` for that pane, or `gone` when herdr tracks no agent there. A pane running a plain shell command, or an agent whose herdr integration was never installed (`herdr integration install claude|opencode|codex|pi|…`, machine-wide), never reports `idle` — the step waits its whole budget and parks. `herdr-factory doctor` does **not** check this; use `herdr integration status`. Prerequisites and how to install them: [install-and-operate.md](./install-and-operate.md).

The repo/belt/step `agent:` block configures only panes the factory **spawns**. In a layout pane you own the harness — set it in the pane's `command:`. See [belts-and-steps.md](./belts-and-steps.md).

---

## Layout selection

```yaml
belt:
  - name: app
    default_layout: app-dev
    layout_matching:
      - { title: hotfixes, worktree_pattern: "hotfix/*", layout: app-dev-hotfix }
```

`resolveBeltLayout` (`src/core/layout-match.ts`): walk `layout_matching` **in written order**; the first rule whose glob matches **and** whose `layout` id exists wins. Otherwise `default_layout` (if set and defined). Otherwise nothing is built.

- `worktree_pattern` is a glob over the **git branch name of the worktree**, not a path. Despite the key's name.
- Full-string anchored. Only `*` (any run of characters, **including `/`**) and `?` (exactly one character) are special; everything else is literal.
- `title` on a rule is documentation only.
- The branch comes from `herdr worktree list --workspace <w> --json` → the entry whose `open_workspace_id` matches (fallback: `path` == the checkout path) → its `branch`.

**Hand-created worktrees** (a branch the factory never claimed) resolve through `resolveHookLayout`: if an **active run** owns that branch, resolve from that run's belt first; otherwise — or if that belt yields nothing — walk **all** the repo's belts and take the first that yields a layout. Belts are sorted by `priority` at load, so "walk the belts" means priority order. There is no workspace-specificity scoring: one config file = one repo.

---

## The build mechanism — the herdr plugin hook

**`applyLayout` has exactly one caller: the herdr event hook** (`src/core/layout-hook.ts`). The reconciler never builds a layout, and never self-heals a missing one. (`src/core/layout.ts` carries a stale comment claiming `reconcileClaiming` builds it — it does not.)

`herdr-plugin.toml` at the factory checkout root declares id `herdr-factory` and three events, all running `["bash", "bin/herdr-factory", "layout-hook"]` (a **relative** command, so herdr must run it with cwd = plugin root):

| event | why |
|---|---|
| `worktree.created` | the factory's own claim path |
| `workspace.created` | other creation paths |
| `workspace.focused` | the herdr UI's "new worktree" command emits **only** this to plugins |

The hook dedupes, so the extra events are harmless. It reads the event **payload** (`HERDR_PLUGIN_EVENT_JSON`, `HERDR_PLUGIN_EVENT`) and never the ambient `HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`, which describe whichever pane happened to be focused.

### Linking

`install.sh` links it best-effort. If `herdr` wasn't on PATH at install time it only warns:
`herdr not on PATH — skipping plugin link. Layouts won't auto-apply until you run: herdr plugin link '<APP_DIR>'`

```sh
herdr plugin link ~/.local/share/herdr-factory     # $HERDR_APP_DIR — the code checkout
```

If a **different** root is already linked under the id `herdr-factory`, unlink first (the id collides):

```sh
herdr plugin unlink herdr-factory && herdr plugin link ~/.local/share/herdr-factory
```

### Verifying it's registered and firing

```sh
herdr plugin list --plugin herdr-factory --json      # plugin_root, enabled, events[]
herdr plugin log list --plugin herdr-factory --limit 5
```

`plugin log list` already emits JSON — passing `--json` errors with `unknown option: --json`. Rows carry `command, event, exit_code, status, started_unix_ms, finished_unix_ms, log_id, plugin_id, stdout, stderr`.

Read the **strings**, not the status:

| row content | meaning |
|---|---|
| `stdout: applied layout "<id>"`, `exit_code: 0` | built |
| `stderr: [layout-hook] <reason>`, `exit_code: 0`, `status: succeeded` | **skipped** — a skip is a deliberate exit 0. `status: succeeded` on a hook that "did nothing" is normal. |
| `stderr: [layout-hook] <message>`, `exit_code: 1`, `status: failed` | the apply threw |

Also: `herdr plugin enable|disable herdr-factory`. `doctor` checks **none** of this — no plugin-link check, no integration check.

> **Do not run a second layout plugin on a factory-managed repo.** `herdr-plugin-workspace-manager` subscribes to the identical three events and will build a competing or duplicate layout into the same worktree — or win the race and leave the factory hook logging `not a fresh 1-tab/1-pane workspace; skipping`. Disable/uninstall it, or drop its mapping for these repos.

### Gates, in order — each string is exactly what lands in the plugin log

1. no workspace id in the payload → `no workspace id in event`
2. focus event **and** already decided → `already decided` (the hot path — no herdr query at all)
3. no checkout path → `not a worktree workspace`
4. not a linked worktree → `main checkout — never touch`
5. no configured repo whose `resolve(repo.path)` equals `resolve(repo_root)` → `no factory repo config for <repoRoot>` (a repo whose `config.yml` currently fails to load is silently skipped here)
6. no layout resolves → `no layout matches <checkoutPath>`
7. not fresh → `workspace <id> is not a fresh 1-tab/1-pane workspace; skipping`
8. already claimed → `layout already applied for <checkoutPath>; skipping`
9. no root tab / pane resolvable → releases the claim and throws `layout hook: no tab found for workspace <id>` / `layout hook: no root pane found for tab <tabId>`

On success: records a `layout_applied` event and logs `layout hook: built "<id>" into <checkoutPath>` to `<state>/<repo>/logs/<YYYY-MM-DD>.log`. On a throw: releases the claim (so a transient failure can retry), records `layout_apply_failed` `{layout, workspaceId, error}`, exits 1.

**`layout_applied`/`layout_apply_failed` for a hand-created worktree carry `run_id = null`**, and `herdr-factory timeline <KEY>` selects by run id — so they never appear there. Use `herdr plugin log list` and the daily repo log.

### Idempotency and freshness

- **Freshness is 1 tab AND 1 pane.** A restored/arranged workspace, `herdr worktree open` on an existing branch, a pane you split before the hook ran, or a **partially-failed earlier apply** all fail this gate — permanently, for that worktree.
- **Applied exactly once per worktree**, keyed on `sha1(resolve(checkoutPath))` under the layout state dir: `<state>/layout-hook/applied/<sha1>/meta.json` = `{path, ino, birthtimeMs}`. `mkdir` is the atomic cross-process lock. A recreated worktree at the same path is detected as stale (inode differs, or birthtime is newer) and re-won. The decided cache (`<state>/layout-hook/decided/<workspaceId>`) is written **only on focus events**.
- State dir = `HERDR_FACTORY_LAYOUT_STATE_DIR`, else `<stateRoot>/layout-hook` (default `~/.local/state/herdr-factory/layout-hook`). **The hook runs in the herdr daemon's environment, not your shell's** — its config dir, state root and `herdr` binary all resolve from there.

**Force a rebuild** — the worktree must also be back to 1 tab / 1 pane, so in practice:

```sh
rm -rf ~/.local/state/herdr-factory/layout-hook/applied   # drop all claims (safe: freshness still gates)
# then remove and recreate the worktree, and focus it (or `herdr worktree create` again)
```

Removing the worktree alone also works: `reapOrphanClaims()` drops `applied/` entries whose recorded path no longer exists.

---

## The layout-wait budget

`limits.layout_wait_seconds`, default **600**. The guard attaches **only** when the step ref supplies both `tab` and `pane` — a step without a layout target never waits and never parks this way.

| phase | behavior |
|---|---|
| within the window | logs `<KEY>: <step> waiting for layout pane <tab>/<pane> (<waited>s/<limit>s)` each tick and retries. The clock is `run_steps.started_at`, created on the first attempt so it spans ticks. |
| window expires, credits left (limit **3**) | bumps the guard counter, **re-arms in place** with a **full fresh window**, records `layout_wait_retry` `{step, tab, pane, attempt, limit}`, logs `… not up after <waited>s — re-arming the wait (retry <a>/<limit>)`. |
| credits exhausted | parks: reason `layout_wait_timeout`, attention `<step>: layout pane <t>/<p> never became available`, body `<step> step (belt <belt>): configured pane <t>/<p> didn't come up with an idle agent within <N>min (3 automatic retries exhausted) — is the herdr layout for this worktree running?` |

**Total wall-clock budget is `(1 + 3) × layout_wait_seconds` = 40 min by default.** The escalation body quotes a **single** window (10 min) — it is misleading; ~40 minutes have actually elapsed.

A `layout_wait_timeout` park can never heal via `step-done` (no agent ever existed), so it is handled by the post-park auto-rescue path instead: while the guard counter is below the limit it flips the run back to `running`/`claiming`, restores the pane label the escalation overwrote, records `resumed` `{reason: "layout_wait_respawn", …}`, and re-dispatches **on the same pass**. But the in-place re-arms and the rescue share **one** `guard_counters(run_id, step, guard)` row — so a park you actually see has already spent the budget and needs a human:

```sh
herdr-factory --repo <repo> resume <KEY>     # refunds the counter → a fresh (1+3)-window budget
```

The counter is also refunded on a successful dispatch. Related: when a live layout pane dies and no replacement resolves, the reconciler logs `<KEY>: <step> replacement pane not available — handing the retry to the layout wait` — **the engine never recreates a dead layout pane**; the hook fires once per worktree.

---

## Failure modes

| symptom | cause | fix |
|---|---|---|
| No layout at all; every `tab`/`pane` step parks `layout_wait_timeout`; `herdr plugin list --plugin herdr-factory --json` empty | plugin never linked (`herdr` absent when `install.sh` ran) | `herdr plugin link ~/.local/share/herdr-factory` |
| Old/unexpected hook behavior | plugin linked at a stale `plugin_root` | `herdr plugin unlink herdr-factory && herdr plugin link <APP_DIR>` |
| `"enabled": false`, no plugin-log rows | plugin disabled | `herdr plugin enable herdr-factory` |
| Duplicate/competing panes, or `not a fresh 1-tab/1-pane workspace; skipping` | a second layout plugin (workspace-manager) on the same events | disable it, or drop its mapping for factory-managed repos |
| `workspace <id> is not a fresh 1-tab/1-pane workspace; skipping` | reopened/arranged worktree, or a pane split before the hook ran | remove + recreate the worktree, or hand-build the tab/pane with byte-identical titles |
| `layout already applied for <path>; skipping` | a reopened worktree at a claimed path | `rm -rf <state>/layout-hook/applied/<sha1>` (or the whole `applied/` dir), then recreate the worktree |
| `no factory repo config for <root>` | `resolve(repo.path)` ≠ herdr's `repo_root` — `resolve()` does **not** realpath, so a symlinked home or `/Users` vs `/System/Volumes/Data` misses | set `repo.path` to exactly what `herdr worktree list --json` reports as `repo_root` |
| `no factory repo config for …` but the path is right | that repo's `config.yml` currently fails to load (the hook swallows it) | `herdr-factory --repo <r> doctor` and fix the config error |
| `no layout matches <checkoutPath>` | the belt has neither `default_layout` nor a matching rule for that branch | add `default_layout`, or drop the steps' `tab`/`pane` and accept dedicated panes |
| Pane exists but the step waits forever | its `command` isn't a herdr-integrated harness → `agent_status` is `gone`, never `idle` | `herdr integration status`; `herdr integration install <agent>` (machine-wide — [install-and-operate.md](./install-and-operate.md)) |
| Endless wait; `tab list`/`pane list` labels differ from config | title mismatch (case, spaces, emoji), or an **untitled** tab/pane | make step `tab`/`pane` byte-identical to the layout titles; give every targeted tab **and** pane a `title` |
| Runtime park on a target that "exists" | the target is only in a `layout_matching` layout — load-time allocation checks `default_layout` only | add the pane to `default_layout` too, or accept the runtime behavior |
| Pane exists under a default label | `herdr pane rename` failed (it's `allowFail`) | `herdr pane rename <id> <title>` by hand, or recreate the worktree |
| `status: failed` row + `layout_apply_failed`, and every retry then skips on freshness | partial apply — the workspace is now multi-tab | fix the underlying herdr failure, then remove + recreate the worktree |
| Later tabs never spawn; the hook hangs | a `blocking: true` setup command that doesn't terminate (capped at 600 s) | make setup non-blocking, or make it exit |
| Hook reads the wrong config dir / state root | `HERDR_FACTORY_CONFIG_DIR` / `HERDR_FACTORY_STATE_ROOT` set in your shell but not in the herdr daemon's env | don't override them, or export them into herdr's environment |

Symptom-first playbooks for the resulting parks are in [troubleshooting.md](./troubleshooting.md).

---

## Worked example

Two tabs: an agent pane beside a dev server, plus a dedicated capture tab for `evidence`. `review` and `pr` take no `tab`/`pane`, so they spawn their own panes — you only need to lay out the panes you actually care about.

```yaml
layouts:
  - id: app-dev
    setup:
      command: pnpm install --frozen-lockfile
      blocking: true # nothing else spawns until deps are installed
    tabs:
      - title: work
        panes:
          - title: agent # step `work` is dispatched here
            command: claude --dangerously-skip-permissions
            setup: true # setup.command runs HERE, before this command
          - title: server # no step targets this — any command is fine
            command: pnpm dev
            split: down # below the agent pane
            size: "35%" # the SERVER pane gets 35% of the tab height
      - title: verify
        panes:
          - title: capture # step `evidence` is dispatched here
            command: claude --dangerously-skip-permissions

belt:
  - name: app
    source: jira
    label: factory # REQUIRED on a jira/github_issues belt — the pickup label (no default); a local_markdown/sentry belt must omit it
    default_layout: app-dev
    steps:
      - { type: work, tab: work, pane: agent }
      - { type: evidence, tab: verify, pane: capture }
      - { type: review } # spawns its own dedicated pane
      - { type: pr } # spawns its own dedicated pane
```

What the hook builds, in order: rename the worktree's root tab to `work` → rename its root pane to `agent` → run `pnpm install --frozen-lockfile` there and **wait** → run `claude` there → split `down` at `--ratio 0.65` → rename that pane `server` → run `pnpm dev` → `tab create --label verify` → rename its root pane `capture` → run `claude`. Copy-paste-ready full configs are in [recipes.md](./recipes.md).
