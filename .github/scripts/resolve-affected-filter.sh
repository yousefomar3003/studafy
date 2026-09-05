#!/usr/bin/env bash
# Prints a turbo `--filter=...[<ref>]` argument on stdout, selecting only packages changed since
# the PR's base commit (or, on a push, the commit before the push) plus their dependents. Prints
# nothing when no usable base commit exists (e.g. push.before is the all-zero SHA for a branch's
# first push), so the caller falls back to running every package.
#
# Requires a full-history checkout (actions/checkout with fetch-depth: 0) so the base commit is
# present locally -- this script never fetches on its own.
set -euo pipefail

base=""
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  base="${PR_BASE_SHA:-}"
elif [ -n "${PUSH_BEFORE_SHA:-}" ] && [ "${PUSH_BEFORE_SHA}" != "0000000000000000000000000000000000000000" ]; then
  base="${PUSH_BEFORE_SHA}"
fi

if [ -n "$base" ] && git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "--filter=...[${base}]"
fi
