# Bug: `worktree remove` partially completes then errors, leaking the workspace + checkout dir (unrecoverable)

**Component:** herdr CLI / server — `worktree remove`
**Version:** herdr 0.7.0
**Platform:** macOS (Darwin 25.2.0)
**Severity:** medium — leaks a workspace + on-disk checkout dir on every occurrence; not self-recoverable via the same command.

## Summary

`herdr worktree remove --workspace <id> --force` is **non-atomic** and **not idempotent**. In a failing run it:

1. deregisters the git worktree (so `git worktree list` no longer shows it, and the branch becomes deletable), **then**
2. errors before closing the herdr workspace and deleting the checkout directory.

Because step 1 already happened, **every subsequent `worktree remove` fails** with `fatal: '<dir>' is not a working tree` — herdr's internal `git worktree remove` has nothing left to remove, so it aborts and never proceeds to close the workspace or delete the dir. The result is a herdr workspace (with all its panes/agents still alive) and an orphaned checkout directory that `worktree remove` can no longer clean up. Recovery requires `herdr workspace close <id>` + a manual `rm -rf` of the dir.

Additionally, the CLI **exits 0 even when the operation errors** (the error is only in the JSON body), which hides the failure from scripts/automation.

## Steps to reproduce

1. Create a worktree workspace from a layout that starts long-lived processes in its panes (e.g. agents + a dev-server). 
2. Invoke `herdr worktree remove --workspace <id> --force` while those panes/processes are live (in our case, automation called it at teardown after a merge).
3. Observe the command return `{"error":{"code":"worktree_remove_failed", ...}}` — but with **exit code 0**.
4. Check state: `git worktree list` no longer lists the worktree (it was deregistered), but `herdr workspace list` still shows the workspace, and the checkout dir still exists on disk.
5. Retry `herdr worktree remove --workspace <id> --force` → now fails `fatal: '<dir>' is not a working tree` and can never complete the cleanup.

## Expected

`worktree remove` either fully completes (git worktree deregistered + workspace closed + dir removed) or, on partial failure, is **safely retryable** so a second call finishes the remaining cleanup. A non-zero exit code on error.

## Actual

Partial completion leaks the workspace + dir, and the command is unrecoverable thereafter. Exit code is 0 despite the error.

## Evidence

CLI (note **exit 0** alongside the error body):

```
$ herdr worktree remove --workspace w25 --force
{"error":{"code":"worktree_remove_failed","message":"fatal: '/Users/raza.jamil/.herdr/worktrees/reckon-frontend/fix-rwr-17269-ui-update-status-bad' is not a working tree"},"id":"cli:worktree:remove"}
$ echo $?
0
```

`herdr-server.log` — the original teardown call errored after ~29s, having already deregistered the git worktree:

```
02:54:34  api.request.start    method="worktree.remove"  request_id="cli:worktree:remove"  changes_ui=true
02:55:03  api.request.complete method="worktree.remove"  outcome="error"
02:56:38  herdr::app::worktrees: starting git worktree remove workspace_id=w25 path=.../fix-rwr-17269-ui-update-status-bad force=false
02:56:38  WARN herdr::app::worktrees: git worktree remove failed workspace_id=w25 path=.../fix-rwr-17269-ui-update-status-bad error=fatal: '.../fix-rwr-17269-ui-update-status-bad' is not a working tree
```

Post-state: workspace `w25` still present with 8 panes + 3 live agents; checkout dir still on disk; git worktree deregistered; branch already deletable. Only `herdr workspace close w25` + `rm -rf <dir>` recovered it.

## Suggested fixes

1. **Tolerate an already-deregistered git worktree.** If the internal `git worktree remove` reports `is not a working tree`, treat the git step as already-done and proceed to close the workspace + remove the dir, rather than aborting the whole operation.
2. **Order/atomicity.** Ensure the workspace-close + dir-removal happen regardless of the git-worktree-remove outcome (or roll back step 1 on later failure) so the command can't leave a half-removed state.
3. **Exit code.** Return a non-zero exit status when the operation errors, so callers can detect failure without parsing the JSON body.
4. **(Optional) `--force` should reap live panes/processes** in the workspace's panes before removing, if a busy dir/process is what causes the underlying failure.

## Workaround

```
herdr workspace close <id>          # closes the workspace + panes (independent of git state)
rm -rf <checkout-dir>               # the orphaned worktree dir (git worktree already deregistered)
git -C <main-checkout> worktree prune
```
