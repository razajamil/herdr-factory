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
