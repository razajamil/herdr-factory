# The end-to-end harness

`npm test` proves the reconciler is right against fakes. This suite proves the **factory** is right:
a real `serve`, a real headless herdr building real worktrees and PTY panes, real agents signalling
through the real CLI, real SQLite, real prompt rendering, real intent delivery — in a container, in
seconds, with machine-readable results.

```sh
scripts/e2e                                   # build the image, run everything, collect artifacts
scripts/e2e --scenario w2pr-happy --keep      # one scenario, keep its world
scripts/e2e --no-build -- --reporter=verbose  # iterate without rebuilding
HF_E2E_SLOW=1 scripts/e2e                     # include the slow scenarios
```

Results land in `artifacts/e2e/<timestamp>/` (`artifacts/e2e/latest` points at the newest):
`summary.md`, `results.json`, `junit.xml`, and per scenario the SQLite DB, the engine log, the herdr
server log, the agent transcript, every rendered prompt, and the `gh`/`herdr` argv traces.

## The model

|  | choice | what it buys |
|---|---|---|
| **Lane** | `real` (default) — a headless `herdr server` per world | the herdr contract, layouts, agent adoption, prompt delivery |
| | `fake` — a shim on `HERDR_BIN_PATH` *(M4, not yet built)* | failure injection herdr won't do on request, and scale without PTYs |
| **Tier** | `scripted` (default) — the harness's agent | determinism: every scenario and edge case, in seconds |
| | `ds4` — a local model via opencode *(M5, not yet built)* | that a real model can follow the **shipped** prompts |
| **Driver** | `serve` (default) — the resident server ticks itself | the production shape: auth gate, poll cadence, `/evidence`, hot reload |
| | `tick` — one pass per call | pass-by-pass determinism when a scenario needs it |

## Writing a scenario

```ts
scenario({ name: "...", briefs: {...}, config: (p) => ({...}), agent: {...} }, async (w) => {
  await w.waitForPhase("my-key", "reviewing");
  w.gh.merge(w.db.run("my-key")!.pr_number!);
  await w.waitForEnd("my-key", "merged");
  expectTimeline(w, "my-key", ["claimed", "pr_opened", "torn_down"]);
});
```

- **`config`** returns the repo's `config.yml`, merged over harness defaults (`repo`, compressed
  `limits`, `agent: claude`). Time is compressed with config, never a fake clock — `core/layout.ts`
  mixes `deps.now()*1000` with `Date.now()`, so an injected clock is unsafe on the layout path.
- **`agent`** is the behaviour script: `commit`, `hangMs`, `signal` (`step-done`/`bounce`/
  `ask-human`/`none`), `captureAttempts`, `evidence`, `replayStalePass`, `openPr`, `run`. Resolution
  is `passes["<step>:<pass>"]` ▸ `steps[step]` ▸ `default` ▸ built-in. `w.setAgentScript()` swaps it
  mid-scenario (the agent re-reads it every turn).
- **Assertions** rank: `w.db.run()/events()/steps()/intents()` → `expectTimeline` /
  `expectParked` / `expectNoPendingIntents` → `w.factory.repoApi("GET", "obligations?key=…")` →
  filesystem (`w.branchExists`, `w.humanInbox`, `w.factory.evidence`) → argv traces
  (`w.herdr.notifications()`, `w.gh.calls()`).
- **Every failure** carries `w.diagnose()`: run state, timeline, engine log, agent transcript, herdr
  agents, and every pane's `process-info` + screen.

The scripted agent **reads the rendered prompt and runs the signal command it finds there** — it
never reconstructs one. That makes the suite a live check of the agent-CLI contract
(ARCHITECTURE §14: those command lines are baked into prompts of agents that outlive any restart).

## Scenarios

| Scenario | Covers |
|---|---|
| `w2pr-happy` | brief → work → review → pr → PR opened → merged → teardown; transition order, branch + worktree reaped |
| `custom-belt` | a `custom` pipeline, config-folder prompt files, token rendering, `completed`, no PR machinery |
| `layouts` | plugin hook, `layout.apply` per tab, blocking setup, splits, step→pane dispatch, pane display metadata, hand-created worktrees |
| `layout-setup-on-agent-pane` | regression: an agent pane that also runs the layout's setup still gets its agent |
| `fast-signal` | regression: a `step-done` that beats its own dispatch is accepted, not dropped |

## Things the harness found — and what changed

Each was reproduced end-to-end, fixed in the engine, and is now pinned by a scenario that fails if it
comes back.

1. **An agent pane that also ran the layout's `setup` command never got an agent.** `paneScript`
   appended `HAND_BACK = exec $SHELL -i` to any agent pane carrying a command, and herdr 0.7.5's
   `agent start` then accepted the request but launched nothing (`agent.get` timed out after 60s;
   `pane process-info` showed the pane's process replaced by a non-login `/bin/bash -i`, where a
   working agent pane shows the agent as a child of herdr's own shell). Every step targeting the pane
   burned its layout wait and the run parked `layout_wait_timeout` — and the shipped README's
   canonical layout is exactly this shape. **Fixed** (`core/layout.ts`): an agent pane is handed to
   herdr as a plain shell and the setup command is run *in* it with `pane run`.
   → `layout-setup-on-agent-pane`.
2. **A signal that arrived before the engine recorded the dispatch was dropped, and the agent could
   not tell.** `reconcileClaiming` wrote `run.step` only after `spawnStep`, which blocks until herdr
   reports the agent ready — with the prompt already delivered on the argv. A `step-done` in that
   window was rejected (`"work" is not the run's active step ("none")`) and the run then waited for a
   signal that never came again, until its budget expired; the rejection **exited 0**. **Fixed**:
   `run.step` is recorded before the dispatch (`core/reconcile.ts`, matching what every later step
   already did) and a rejected signal now prints to stderr and exits 1 (`cli/index.ts`). Because
   `run.step` is now set during `claiming`, "still claiming" is read from `isPreDispatchClaim`.
   → `fast-signal`, which asserts the race actually happens *and* is handled.
3. **`HERDR_AGENT` in a pane's env pre-claims the pane** — `agent start` answers `agent_pane_busy:
   not an available shell` — and the factory was setting that hint on the very pane it was about to
   adopt into. **Fixed** (`clients/herdr.ts`): the hint is set only on the typed (`run`) path, which
   is the case it exists for. → covered by every adopt-path scenario.
4. **herdr identifies a pane's agent by the foreground process's `argv[0]`.** `exec node agent.cjs`
   is never detected (60s timeout); `exec -a claude node agent.cjs` is adopted in ~3s. Not an engine
   bug — a fact anything wrapping an agent must respect (the harness's own shims do).
5. **`pane report-agent` takes agent authority over a pane**: calling it during startup knocks out
   herdr's own adoption record and `agent start` then fails on `agent.get`. Real harnesses don't call
   it; neither does the scripted agent.
6. **Documentation drift** (fixed): `runs.pr_number` / `resolver_active` / `last_thread_sig` moved to
   `run_products` in v18 but ARCHITECTURE §6 still showed them on `runs`; the §6 event list named
   `merged`/`closed`, which nothing emits, and omitted `layout_applied`, `layout_apply_failed`,
   `intent_deadline`, `intent_fulfilled`.

## Container notes (learned the hard way)

- The world root is **short** (`/h/<id>`): herdr's socket lives under its config dir and a long path
  overflows `sun_path`, killing the server at boot.
- Panes inherit the **herdr server's** environment, so the server is started with the whole world env
  — that is what makes an agent's `herdr-factory step-done` reach the world's config and state.
- The world's `herdr` wrapper (which records argv) must exec an **absolute** real herdr, or it
  re-resolves to itself and exec-loops.
- `notification show` degrades to `{shown:false, reason:"disabled"}` in a container — harmless, and
  the wrapper's argv log is how notifications are asserted.

## Not built yet (the plan's later milestones)

M2 attention + human loop (budget/stall/read-only/bounce-cap/ask-human/missing-API-key/evidence
retry/PR-closed/resolver-wake) · M3 source parity (fake Jira + Sentry over their configurable
`base_url`; `github_issues` needs a `GITHUB_API_URL` seam) + belt/config breadth · M4 the fake-herdr
lane and the performance scenarios (call budgets, scale drain, tick latency, resource soak) ·
M5 the DS4 tier and the TUI boot assertion.
