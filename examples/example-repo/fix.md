<!-- prompt_type: augment — this file's contents are appended to the engine's built-in fix
     prompt as extra, repo-specific instructions. Keep it to the extras; the base prompt
     already covers reading the ticket, studying attachments, implementing, verifying, and
     committing. (To own the whole prompt instead, set prompt_type: replace and write a full
     prompt here.) -->

## Extra fix-step notes for this repo

- Dependencies are already installed by the workspace setup — don't reinstall them.
- Run `npm run lint` and `npm run typecheck` before each commit, not just at the end.
