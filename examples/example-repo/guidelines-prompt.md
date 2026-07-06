<!-- Appended verbatim to every worker brief for this repo. Name the repo's own
     skills/commands/conventions the generic brief can't know about. Delete if unused. -->

- Open the PR using the repo's PR skill/command; if `gh pr edit --body` doesn't
  persist, set the body via the GitHub REST API.
- Commit with the repo's semantic-commit convention.
- Run the repo's full verify gate (lint + type-check + tests) and fix all findings.
- For dev servers + screenshots, use the repo's documented dev-server workflow,
  then drive `playwright-cli`.
- Test accounts + personas: for evidence capture, seed/reset data with the repo's
  documented fixture step, then sign in as the seeded account for the role under
  test (e.g. `user@example.test` for a normal user, `admin@example.test` for
  admin-only flows) — demonstrate each change as the role the work item implies.
- When addressing PR review comments, follow the repo's PR-resolution workflow.
