# Testing the factory

Two suites, and they answer different questions.

| | `npm test` | `scripts/e2e` |
|---|---|---|
| What runs | vitest against fakes + `:memory:` SQLite | the real `serve`, a real headless herdr, real worktrees/panes, real SQLite — in a container |
| Answers | "is the reconciler's logic right?" | "does the factory actually work?" |
| Cost | ~8s | ~15–20s per scenario |

Use the e2e suite when a change touches dispatch, layouts, the herdr surface, prompts, signals,
teardown, or anything whose failure mode is "it looked fine in unit tests". It is the only thing that
exercises the herdr CLI contract — the class of breakage that hit the 0.7.5 `agent start` change.

## Running it

```sh
scripts/e2e                                   # build the image, run everything
scripts/e2e --scenario w2pr-happy --keep      # one scenario, keep its world dir
scripts/e2e --no-build -- --reporter=verbose  # iterate without rebuilding the image
HF_E2E_SLOW=1 scripts/e2e                     # include scenarios that wait out an engine clock
```

Needs Docker. Artifacts land in `artifacts/e2e/<timestamp>/` (`…/latest` symlink): `summary.md`,
`results.json`, `junit.xml`, and per scenario the DB, the engine log, the herdr server log, the agent
transcript, every rendered prompt, and the `gh`/`herdr` argv traces.

**It cannot touch a real install.** Each scenario builds a hermetic world under `/h/<id>`: its own
HOME, herdr config + socket, `HERDR_FACTORY_CONFIG_DIR`/`_STATE_ROOT`, port, target git checkout and
bare `origin`. No network, no real GitHub, no real herdr session.

## What a scenario looks like

`test/e2e/scenarios/*.e2e.ts` — a spec (config.yml to write, briefs to drop, how the agent should
behave) plus assertions:

```ts
scenario({
  name: "w2pr-happy",
  briefs: { "add-hello": "# Add a hello file\n" },
  config: (p) => ({
    work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
    belt: [{ name: "briefs-to-prs", source: "briefs", steps: [{ type: "work" }, { type: "review" }, { type: "pr" }] }],
  }),
  agent: { steps: { review: { commit: false } } },
}, async (w) => {
  await w.waitFor(() => (w.db.run("add-hello")?.pr_number ?? 0) > 0);
  w.gh.merge(w.db.run("add-hello")!.pr_number!);
  await w.waitForEnd("add-hello", "merged");
  expectTimeline(w, "add-hello", ["claimed", "pr_opened", "torn_down"]);
});
```

Agent behaviours available per step (and per pass): `commit`, `hangMs`, `signal`
(`step-done`/`bounce`/`ask-human`/`none`), `captureAttempts`, `evidence`, `replayStalePass`,
`openPr`, `run`, `noHandoff`. That is how attention parks, bounce loops and stuck runs are provoked
deterministically. Full guide: `test/e2e/README.md`.

## Facts worth knowing before you debug a pane

These were established by the harness against herdr 0.7.5 and explain most "the agent never started"
reports:

- herdr identifies a pane's agent by the foreground process's **`argv[0]`**. A wrapper must
  `exec -a <kind> …`; `exec node wrapper.js` is never detected and `agent start` times out after 60s.
- `HERDR_AGENT=<kind>` in a pane's env **pre-claims** the pane — `agent start` then answers
  `agent_pane_busy: not an available shell`.
- `pane report-agent` takes agent authority over a pane; calling it during startup breaks herdr's own
  adoption record. Real harnesses don't call it.
- **An agent pane may not carry a command as its process.** herdr won't adopt an agent into a shell
  that a wrapper `exec`'d, so the layout's setup command is run *in* an agent setup pane rather than
  baked into it. (Before that fix, `setup: true` on an agent pane meant `could not start <kind> in
  <pane>`, `layout_wait_retry` ×3, then a `layout_wait_timeout` park.)
- **A rejected signal exits 1** and prints to stderr, so an agent can tell. The engine also records a
  run's active step *before* dispatching it, so an agent that finishes faster than herdr's readiness
  handshake still has its `step-done` accepted.
