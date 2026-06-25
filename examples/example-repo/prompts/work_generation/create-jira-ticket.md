# Create Jira ticket — @@KEY@@

You are the **create_jira_ticket** step of the **@@BELT@@** belt (steps: @@STEPS@@) — the LAST
step. When you signal step-done, the belt is complete and herdr-factory tears the worktree down
(there is no PR and no review watch for this belt).

## Input
- Read the proposal from the previous step's handoff: `@@HANDOFF_IN@@`.

## Do
1. Create a Jira ticket that captures the proposal: a clear summary, the description/approach, and
   the acceptance criteria. Use your Jira tooling (the Atlassian MCP server, `jira` CLI, or the
   REST API with the team's project/issue-type conventions).
2. Put the created ticket's key + URL in your handoff note.
3. If you can't create the ticket (auth, permissions, missing project), say so clearly in your
   handoff and stop — do not invent a ticket key.

Do NOT change this work item's status — the dispatcher owns that.
