# CLAUDE.md

Guidance for agents working in this repository.
(All paths below are relative to the repository root.)

## Read this first — before any work

Before making changes, running tasks, or answering non-trivial questions about
this codebase, **read these two documents to understand the project**:

1. `README.md` — what the factory is, how it's installed and configured, the
   belt/step model, sources, layouts, prompts, commands, and the overall
   workflow.
2. `docs/ARCHITECTURE.md` — the engine internals: reconciler phases, locking,
   the outbox, rate limits, and the invariants the code must uphold.

Do not skip this. The design is opinionated and the invariants are load-bearing;
a change that reads reasonable in isolation can violate an assumption documented
only in these files. When a task touches reconciliation, claiming, step
execution, sources, or state, re-read the relevant section of
`docs/ARCHITECTURE.md` before editing.

## Project snapshot

herdr-factory is an autonomous work → pull-request factory built on
[herdr](https://herdr.dev): work items (Jira tickets, GitHub issues, or Markdown
briefs) flow through a **belt** — an ordered pipeline of composable step
primitives (`work`, `evidence`, `review`, `pr`, `custom`) — and come out as
merged PRs. The engine is TypeScript run directly via Node's native
type-stripping (no build step), with all state in the built-in `node:sqlite`.

## Keep the docs and the skill in sync — every functional change

Any change to how the factory behaves ships **with** its documentation, in the
same commit. Whenever you change functionality, update all three:

1. `README.md` — the user-facing surface: config keys, CLI commands, the
   belt/step model, sources, layouts, prompts, workflow.
2. `docs/ARCHITECTURE.md` — the engine internals: reconciler phases, locking,
   the outbox, rate limits, invariants.
3. `skills/herdr-factory/` — the shipped consumer skill (`SKILL.md` +
   `references/`), which is how users and agents actually operate the factory.

This is not optional polish. The skill is symlinked into installed agent configs
and auto-updates from this checkout, so a merge that leaves it stale immediately
gives users confidently wrong answers. Treat a functional change with
out-of-date docs as an incomplete change.

If a change genuinely touches none of the three, say so explicitly rather than
silently skipping the step.

## Working in this repo

```sh
pnpm install          # Node ≥ 26 (.node-version pins the version)
npm test              # vitest
npm run typecheck
npm run schema        # regenerate the committed config.schema.json after schema changes
```

- Keep docs verified against source, not against older prose — the zod config
  schema and `install.sh` are the sources of truth for config and install
  behavior.
- After changing the config zod schema, run `npm run schema` (a test guards the
  committed `config.schema.json` against drift).
- `skills/herdr-factory/` is the shipped **agent skill** — the user-facing
  operating manual (`SKILL.md` + `references/`), installed into a user's agent
  config by `herdr-factory skill install` and symlinked to this checkout, so a
  merge here reaches every installed skill on the next auto-update. It restates
  facts that live in source: config keys and defaults, load-time error text, step
  primitive declarations, prompt tokens, CLI flags, attention reason codes. When
  you change any of those, update the matching reference file in the same commit —
  a stale skill gives users confidently wrong answers, which is worse than no
  skill. `references/config-reference.md` tracks the zod schema; `troubleshooting.md`
  tracks the attention reason codes and doctor checks; `cli.md` tracks the commander
  definitions.
