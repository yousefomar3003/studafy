#!/usr/bin/env bash
# QA-006: every third-party GitHub Action is pinned to a full commit SHA.
#
# A tag such as `@v2` can be moved by whoever controls (or compromises) the upstream repository,
# and the moved tag then runs in our CI with its secrets (the tj-actions/changed-files incident).
# A 40-character commit SHA cannot be moved. Keep the release beside it as a comment
# (`@<sha> # v2.2.0`) so Dependabot can propose updates and reviewers can read the version.
#
# Local actions (`uses: ./...`) and container images (`uses: docker://...`) are exempt.
#
#   scripts/ci/check-pinned-actions.sh [directory]   (default: .github)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github}"

offenders="$(
  grep -rnE '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*' "$ROOT" --include='*.yml' --include='*.yaml' \
    | grep -vE 'uses:[[:space:]]*["'"'"']?\./' \
    | grep -vE 'uses:[[:space:]]*["'"'"']?docker://' \
    | grep -vE 'uses:[[:space:]]*["'"'"']?[^@[:space:]]+@[0-9a-f]{40}(["'"'"'[:space:]]|$)' \
    || true
)"

if [ -n "$offenders" ]; then
  echo "Actions not pinned to a full commit SHA (QA-006):" >&2
  echo "$offenders" >&2
  exit 1
fi
echo "All actions are pinned to a commit SHA."
