#!/usr/bin/env bash
# Maintains the single sticky "PR preview" comment on a pull request — created on the first
# successful build, updated in place after that (never a new comment per push). Shared by
# pr-preview.yml and pr-preview-teardown.yml.
#
# Usage:  pr-preview-comment.sh <ready|failed|torn-down>
#
# Environment:
#   GH_TOKEN                required — a token with pull-requests: write
#   PR_NUMBER              optional — defaults to the number in $GITHUB_EVENT_PATH
#   PREVIEW_URL            required for `ready`
#   HEAD_SHA              used by `ready` / `failed` to name the commit
#   RUN_URL               link back to the workflow run
set -euo pipefail

STATE="${1:?usage: pr-preview-comment.sh <ready|failed|torn-down>}"
MARKER="<!-- studafy:pr-preview -->"
PR_NUMBER="${PR_NUMBER:-$(jq -r '.number // .pull_request.number' "$GITHUB_EVENT_PATH")}"
SHORT_SHA="${HEAD_SHA:0:7}"

case "$STATE" in
  ready)
    : "${PREVIEW_URL:?PREVIEW_URL is required for the ready state}"
    body="$(cat <<EOF
${MARKER}
### 🌐 Preview environment

| | |
|---|---|
| **URL** | ${PREVIEW_URL} |
| **Commit** | \`${SHORT_SHA}\` |
| **Updated** | $(date -u '+%Y-%m-%d %H:%M UTC') |

Served over plain \`http\` on port \`8080\` (no load balancer, no per-preview certificate — that is
the trade for a fast, residue-free preview). The demo tenant (\`demo-academy\`) is seeded into an
isolated \`preview_pr_${PR_NUMBER}\` database. Torn down automatically when this PR closes.

<sub>[workflow run](${RUN_URL})</sub>
EOF
)"
    ;;
  failed)
    body="$(cat <<EOF
${MARKER}
### ⚠️ Preview environment — build failed

The preview for \`${SHORT_SHA}\` did not come up. See the [workflow run](${RUN_URL}) for the failing
step. Any earlier preview for this PR is unaffected and still running.
EOF
)"
    ;;
  torn-down)
    body="$(cat <<EOF
${MARKER}
### 🧹 Preview environment — torn down

The preview task, its DNS record and its \`preview_pr_${PR_NUMBER}\` database have been removed.
<sub>[workflow run](${RUN_URL})</sub>
EOF
)"
    ;;
  *)
    echo "unknown state '$STATE'" >&2
    exit 2
    ;;
esac

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$body" > "$tmp"

existing_id="$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --paginate \
  --jq "map(select(.body | startswith(\"${MARKER}\"))) | .[0].id // empty")"

if [ -n "$existing_id" ]; then
  gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing_id}" \
    -F "body=@${tmp}" --jq '.html_url'
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
    -F "body=@${tmp}" --jq '.html_url'
fi
