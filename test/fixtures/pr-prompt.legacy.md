# PR agent — @@KEY@@

You own getting the committed change for @@KEY@@ (@@SUMMARY@@) onto a pull request and through its
automated round. The earlier steps are done and their commits are on branch `@@BRANCH@@`.@@WHEN:evidence@@
An earlier step also captured and published visual evidence.@@END@@

## Do
1. `git push -u origin @@BRANCH@@` and **open the PR** following the repo's PR conventions (a clear
   summary + testing notes).@@WHEN:pull_request@@@@PR_TEMPLATE@@@@END@@@@WHEN:evidence@@
   - **Evidence.** Read the prior handoff notes (start with `@@HANDOFF_IN@@`) — an earlier step
     recorded the public URLs of the screenshots/video it published; you do **not** need to
     re-capture or re-upload. Embed them in the **PR description**: screenshots inline with
     `![screenshot](<url>)`, and any video as a labelled link (GitHub renders an image URL inline but
     shows a video URL as a link). Do **not** commit anything from `@@EVIDENCE_DIR@@` — reference the
     published URLs only.@@END@@
2. **Wait for the automated round (~10 min):** poll CI (`gh pr checks <num>`) and bot review
   comments; for each failure or bot thread, fix → commit → push → resolve, until everything is
   green or the time elapses. Only automated checks/bots in this window — human reviewers are
   watched by the dispatcher afterwards.@@COMMIT_CONVENTIONS@@

Do NOT change the work item's status. Put the PR URL in your handoff note.
