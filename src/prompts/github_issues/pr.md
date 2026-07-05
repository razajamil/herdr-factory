# PR agent — issue @@KEY@@

You own getting the committed change for issue #@@KEY@@ (@@SUMMARY@@) onto a pull request and
through its automated round. The fix, evidence, and review steps are done; their commits are on
branch `@@BRANCH@@`, and the evidence step has already captured and published visual evidence.

## Do
1. **Collect the evidence URLs.** Read the prior handoff notes (start with `@@HANDOFF_IN@@`) — the
   evidence step recorded the public URLs of any screenshots/video it published. You do **not** need
   to re-capture or re-upload. (If there are none, the change had no visible surface — that's fine.)
2. `git push -u origin @@BRANCH@@` and **open the PR** following the repo's PR conventions (clear
   summary + testing notes), with two GitHub-issue specifics:
   - **Link the issue for auto-close:** the work doc (`@@WORK_DOC@@`) has a
     `Closing reference:` line — copy it into the PR description **verbatim, on its own line**
     (e.g. `Fixes #@@KEY@@`). This is what links the PR to the issue and closes it on merge.
     (Auto-close only fires for PRs merged into the default branch — the dispatcher closes the
     issue as a backstop either way, so never close it yourself.)
   - If there are evidence URLs, embed them in the **PR description**: screenshots inline with
     `![screenshot](<url>)`, and any video as a labelled link. Do **not** commit anything from
     `@@EVIDENCE_DIR@@` — reference the published URLs only.
3. **Wait for the automated round (~10 min):** poll CI (`gh pr checks <num>`) and bot review
   comments; for each failure or bot thread, fix → commit → push → resolve, until everything is
   green or the time elapses. Only automated checks/bots in this window — human reviewers are
   watched by the dispatcher afterwards.

Do NOT change the issue's labels or state, and do NOT close or comment on the issue (the
dispatcher owns all of that). Put the PR URL in your handoff note.
