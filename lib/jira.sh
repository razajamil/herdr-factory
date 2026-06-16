#!/bin/bash
# Jira Cloud REST layer. Deterministic, non-interactive: basic auth with an API
# token (JIRA_EMAIL:JIRA_API_TOKEN). No MCP, no node — fast and reliable for an
# unattended loop, and it can fetch attachment binaries (which OAuth cannot).
# Source after config.sh + log.sh.
#
# Transitions are IDEMPOTENT (no-op if already in target) and matched
# case-insensitively, which keeps the reconciler safe to stop/restart mid-flight
# and immune to status-name capitalization drift.

set -euo pipefail

jira_require_auth() {
  if [[ -z "$JIRA_EMAIL" || -z "$JIRA_API_TOKEN" ]]; then
    log_error "Jira auth missing. Set JIRA_EMAIL + JIRA_API_TOKEN in $HERDR_CATS_ENV_FILE"
    return 1
  fi
}

# jira_curl METHOD PATH [json-body] — echoes body, non-zero (logged) on HTTP >=400.
jira_curl() {
  local method
  local path
  local body
  local tmp
  local code
  method="$1"
  path="$2"
  body="${3:-}"
  tmp="$(mktemp)"

  if [[ -n "$body" ]]; then
    code="$(curl -sS --max-time 45 -o "$tmp" -w '%{http_code}' \
      -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
      -X "$method" -H 'Accept: application/json' -H 'Content-Type: application/json' \
      --data "$body" "$JIRA_BASE_URL$path")"
  else
    code="$(curl -sS --max-time 45 -o "$tmp" -w '%{http_code}' \
      -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
      -X "$method" -H 'Accept: application/json' "$JIRA_BASE_URL$path")"
  fi

  if [[ "$code" -ge 400 ]]; then
    log_error "Jira $method $path -> HTTP $code: $(head -c 400 "$tmp")"
    rm -f "$tmp"
    return 1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

_jira_uri_encode() { jq -rn --arg s "$1" '$s|@uri'; }

# Eligible = on board 254 (its saved filter honoured by the Agile endpoint),
# status "To Do", label "agent". Echoes a compact JSON array of {key,summary,type}.
jira_list_eligible() {
  local jql
  local enc
  local resp
  jql="status = \"$HERDR_CATS_STATUS_TODO\" AND labels = \"$HERDR_CATS_JIRA_LABEL\" ORDER BY created ASC"
  enc="$(_jira_uri_encode "$jql")"
  resp="$(jira_curl GET "/rest/agile/1.0/board/$HERDR_CATS_JIRA_BOARD/issue?jql=$enc&fields=summary,issuetype&maxResults=50")" || return 1
  printf '%s' "$resp" | jq -c '[.issues[]? | {key, summary: .fields.summary, type: .fields.issuetype.name}]'
}

# jira_get_issue KEY -> full issue JSON (summary, description, attachments, status).
jira_get_issue() {
  jira_curl GET "/rest/api/3/issue/$1?fields=summary,description,issuetype,status,labels,attachment&expand=renderedFields"
}

jira_current_status() {
  jira_get_issue "$1" | jq -r '.fields.status.name // ""'
}

# jira_transition KEY TARGET_STATUS_NAME — idempotent, case-insensitive match.
jira_transition() {
  local key
  local target
  local current
  local tid
  key="$1"
  target="$2"
  current="$(jira_current_status "$key")" || return 1
  if [[ "$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')" ]]; then
    log_info "$key already in '$target' — transition is a no-op"
    return 0
  fi

  tid="$(jira_curl GET "/rest/api/3/issue/$key/transitions" \
    | jq -r --arg t "$target" '.transitions[] | select((.to.name | ascii_downcase) == ($t | ascii_downcase)) | .id' | head -1)"
  if [[ -z "$tid" ]]; then
    log_error "$key: no transition from '$current' to '$target' available"
    return 1
  fi
  jira_curl POST "/rest/api/3/issue/$key/transitions" \
    "$(jq -cn --arg id "$tid" '{transition: {id: $id}}')" >/dev/null || return 1
  log_info "$key transitioned '$current' -> '$target'"
}

# jira_download_images KEY OUT_DIR — image attachments only, count/size capped.
# Best-effort: a single bad attachment does not abort the rest. Echoes filenames.
jira_download_images() {
  local key
  local out
  local issue
  local rows
  local n
  key="$1"
  out="$2"
  mkdir -p "$out"
  issue="$(jira_get_issue "$key")" || return 1

  rows="$(printf '%s' "$issue" | jq -c \
    --argjson max "$HERDR_CATS_MAX_IMAGES" \
    --argjson maxbytes "$HERDR_CATS_MAX_IMAGE_BYTES" '
      [.fields.attachment[]?
        | select((.mimeType // "") | startswith("image/"))
        | select((.size // 0) <= $maxbytes)
      ] | .[0:$max] | .[] | {filename, content}')"

  n=0
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    local fname
    local url
    local safe
    fname="$(printf '%s' "$row" | jq -r '.filename')"
    url="$(printf '%s' "$row" | jq -r '.content')"
    safe="$(printf '%s' "$fname" | tr -c 'A-Za-z0-9._-' '_')"
    if curl -sS --max-time 60 -L -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -o "$out/$safe" "$url" && [[ -s "$out/$safe" ]]; then
      printf '%s\n' "$safe"
      n=$(( n + 1 ))
    else
      log_warn "$key: failed to download attachment $fname"
      rm -f "$out/$safe"
    fi
  done < <(printf '%s\n' "$rows")
  log_info "$key: downloaded $n image attachment(s) to $out"
}
