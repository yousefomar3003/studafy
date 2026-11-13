#!/usr/bin/env bash
# Prints the commit to diff against on stdout: the PR's base commit, or (on a push) the commit
# before the push -- whichever is available and present locally. Prints nothing when neither
# applies (e.g. push.before is the all-zero SHA for a branch's first push), leaving it to the
# caller to fall back to a full, non-diff-aware run.
#
# Requires a full-history checkout (actions/checkout with fetch-depth: 0) so the base commit is
# present locally -- this script never fetches on its own. Shared by resolve-affected-filter.sh
# (turbo's affected-package filter) and the sast job (Semgrep's --baseline-commit), so both tools
# diff against the exact same commit.
set -euo pipefail

base=""
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  base="${PR_BASE_SHA:-}"
elif [ -n "${PUSH_BEFORE_SHA:-}" ] && [ "${PUSH_BEFORE_SHA}" != "0000000000000000000000000000000000000000" ]; then
  base="${PUSH_BEFORE_SHA}"
fi

if [ -n "$base" ] && git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "$base"
fi
