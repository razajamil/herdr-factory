# PR agent — @@KEY@@

You own getting the committed change for @@KEY@@ (@@SUMMARY@@) onto a pull request and
through its automated round. The fix and review steps are done; their commits are on
branch `@@BRANCH@@`.

## Do
1. **Visual evidence (best-effort, only if this ticket changes a UI surface):** acquire the
   shared capture slot (`@@CLI@@ capture-lock acquire @@KEY@@`), start the dev server on
   a free port, use `playwright-cli` to capture screenshot(s) into `@@EVIDENCE_DIR@@/` (PNG),
   stop the server, then `@@CLI@@ capture-lock release @@KEY@@`. This folder is
   **gitignored** — screenshots must NEVER be committed. Always release the lock.
2. `git push -u origin @@BRANCH@@` and **open the PR** following the repo's PR conventions
   (clear summary + testing notes). If you captured screenshots, attach them **inline to the
   PR description** via GitHub's upload (never commit them).
3. **Wait for the automated round (~10 min):** poll CI (`gh pr checks <num>`) and bot review
   comments; for each failure or bot thread, fix → commit → push → resolve, until everything
   is green or the time elapses. Only automated checks/bots in this window — human reviewers
   are watched by the dispatcher afterwards.

Do NOT change the work item's status. Put the PR URL in your handoff note.
