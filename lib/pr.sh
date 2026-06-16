#!/bin/bash
# GitHub PR query layer for the watcher. Read-only via `gh`. The worker creates
# the PR and writes its body (screenshots, REST-API fallback) itself — the
# dispatcher only observes PR state. Source after config/log.

# The GraphQL query below uses single quotes with GraphQL vars ($owner etc.).
# shellcheck disable=SC2016

set -euo pipefail

# owner/name for the repo. Derived from the checkout's origin remote unless
# HERDR_CATS_GH_REPO overrides it.
pr_repo() {
  local url
  if [[ -n "$HERDR_CATS_GH_REPO" ]]; then
    printf '%s\n' "$HERDR_CATS_GH_REPO"
    return
  fi
  url="$(git -C "$HERDR_CATS_REPO_CWD" remote get-url origin 2>/dev/null || printf '')"
  printf '%s\n' "$url" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##'
}

# Echo the PR for a branch as {number,state,url,mergedAt} or empty if none.
# state is OPEN | MERGED | CLOSED.
pr_for_branch() {
  local branch
  local repo
  branch="$1"
  repo="$(pr_repo)"
  gh pr list --repo "$repo" --head "$branch" --state all \
    --json number,state,url,mergedAt --limit 1 2>/dev/null \
    | jq -c '.[0] // empty'
}

# A stable signature of "actionable review state": unresolved review threads
# (with their latest comment ids, so new comments on an existing thread change
# the signature) + failing required checks. Echoes "<unresolved>|<failing>|<sig>".
pr_review_signature() {
  local number
  local repo
  local owner
  local name
  local threads
  local checks
  local unresolved
  local failing
  local sig
  number="$1"
  repo="$(pr_repo)"
  owner="${repo%%/*}"
  name="${repo##*/}"

  threads="$(gh api graphql -f query='
    query($owner:String!, $name:String!, $number:Int!) {
      repository(owner:$owner, name:$name) {
        pullRequest(number:$number) {
          reviewThreads(first:100) {
            nodes { isResolved comments(last:1) { nodes { id } } }
          }
        }
      }
    }' -F owner="$owner" -F name="$name" -F number="$number" 2>/dev/null \
    | jq -c '[.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved == false)
        | (.comments.nodes[0].id // "x")]' 2>/dev/null)"
  [[ -z "$threads" || "$threads" == "null" ]] && threads='[]'
  unresolved="$(printf '%s' "$threads" | jq 'length')"

  checks="$(gh pr view "$number" --repo "$repo" --json statusCheckRollup 2>/dev/null \
    | jq -c '[(.statusCheckRollup // [])[]
        | select((.conclusion // .state // "") | test("FAIL|ERROR|TIMED_OUT|CANCELLED|FAILURE"))
        | (.name // .context // "check")]' 2>/dev/null)"
  [[ -z "$checks" || "$checks" == "null" ]] && checks='[]'
  failing="$(printf '%s' "$checks" | jq 'length')"

  sig="$(jq -cn --argjson t "$threads" --argjson c "$checks" '{t:$t,c:$c}' | shasum | awk '{print $1}')"
  printf '%s|%s|%s\n' "$unresolved" "$failing" "$sig"
}
