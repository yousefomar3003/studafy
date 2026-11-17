#!/usr/bin/env bash
# QA-073: every .trivyignore waiver carries a review date, and CI fails once it has passed.
#
# A waiver with no end date outlives its reason: the base image or dependency it excused changes,
# and nobody looks again. Each ignored ID must have a `# review-by: YYYY-MM-DD` line in the comment
# block directly above it. On or after that date this check fails, so someone either removes the
# waiver (the finding is fixed) or re-justifies it with a new date.
#
#   scripts/ci/check-trivyignore-expiry.sh [file]   (default: .trivyignore at the repo root)
#   TODAY=YYYY-MM-DD overrides today's date (UTC), for tests.
set -euo pipefail

FILE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.trivyignore}"
TODAY="${TODAY:-$(date -u +%Y-%m-%d)}"

awk -v today="$TODAY" '
  function fail(message) { print FILENAME ":" FNR ": " message > "/dev/stderr"; bad = 1 }
  # A blank line ends a comment block, so a date only covers the ID right below its block.
  /^[[:space:]]*$/ { review = ""; next }
  /^[[:space:]]*#/ {
    # Only a line that is itself `# review-by: <date>`, so prose that mentions the format is ignored.
    if ($0 ~ /^[[:space:]]*#[[:space:]]*review-by:/) {
      value = $0
      sub(/^[[:space:]]*#[[:space:]]*review-by:[[:space:]]*/, "", value)
      sub(/[[:space:]]+$/, "", value)
      if (value !~ /^[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]$/) {
        fail("review-by date \"" value "\" is not YYYY-MM-DD")
        value = "invalid"
      }
      review = value
    }
    next
  }
  {
    id = $1
    count++
    if (review == "") fail(id ": no \"# review-by: YYYY-MM-DD\" in the comment block above it")
    else if (review != "invalid" && review <= today) fail(id ": waiver expired on " review " (today is " today "); fix the finding or re-justify it with a new date")
    review = ""
  }
  END {
    if (bad) exit 1
    print count + 0 " .trivyignore waiver(s), all with a review date after " today "."
  }
' "$FILE"
