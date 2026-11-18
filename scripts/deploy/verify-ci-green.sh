#!/usr/bin/env bash
# QA-005: refuse to release a commit unless it is on the release branch and CI passed for it.
#
#   verify-ci-green.sh <owner/repo> <sha> <git ref> [workflow file, default ci.yml] [branch, default main]
#
# The newest push run of the CI workflow for exactly this SHA on the release branch must be
# `completed` with conclusion `success`. Missing, running, failed or cancelled runs all refuse.
# `GH` overrides the gh binary (tests).
set -euo pipefail

repo="$1"
sha="$2"
ref="$3"
workflow="${4:-ci.yml}"
branch="${5:-main}"
gh_bin="${GH:-gh}"

if [ "$ref" != "refs/heads/$branch" ]; then
  echo "::error::Production deploys only from $branch; this run is on $ref." >&2
  exit 1
fi
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Not a full commit SHA: $sha" >&2
  exit 1
fi

runs="$("$gh_bin" api "repos/$repo/actions/workflows/$workflow/runs?head_sha=$sha&event=push&branch=$branch&per_page=50")"
latest="$(jq -c '[.workflow_runs[]? | select(.head_sha == "'"$sha"'")] | sort_by(.created_at) | last // empty' <<< "$runs")"

if [ -z "$latest" ]; then
  echo "::error::No $workflow push run found for $sha on $branch; CI must pass before a release." >&2
  exit 1
fi

status="$(jq -r '.status' <<< "$latest")"
conclusion="$(jq -r '.conclusion // "none"' <<< "$latest")"
url="$(jq -r '.html_url // ""' <<< "$latest")"
if [ "$status" != "completed" ]; then
  echo "::error::$workflow for $sha is still $status ($url); wait for it to finish." >&2
  exit 1
fi
if [ "$conclusion" != "success" ]; then
  echo "::error::$workflow for $sha concluded $conclusion ($url); fix CI before releasing." >&2
  exit 1
fi
echo "CI passed for $sha on $branch: $url"
