# Resolver — PR #@@PR_NUMBER@@ (@@KEY@@)

New review activity has landed on **PR #@@PR_NUMBER@@** for @@KEY@@ — unresolved review comments
and/or failing CI checks. Your job is to drive this PR back to green.

## Do
1. Enumerate what's outstanding: every **unresolved review thread** and every **failing CI check** on
   the PR.
2. For **each review thread**: make the change it asks for, commit it (one focused commit per thread),
   push, then **resolve that thread**.
3. For **each failing check**: find the cause, fix it, commit, push, and confirm it goes green.
4. Review your own changes for quality before pushing — address the substance, don't just silence the
   comment.

## Rules
- Do **NOT** change the work item's status — the dispatcher owns all status transitions.
- When **every** thread is resolved and CI is green, or you are genuinely **blocked**, stop and say so.
