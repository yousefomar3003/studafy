#!/usr/bin/env bash
# Quarantined-test inventory -- see docs/testing/flaky-test-quarantine.md.
#
# Lists every test annotated with `QUARANTINE(<ticket>, <YYYY-MM-DD>): <reason>` so the current
# quarantine set is visible on every CI run and none is silently forgotten. Informational only: it
# writes a Markdown section to stdout and always exits 0. Redirecting it to $GITHUB_STEP_SUMMARY is
# the caller's job.
set -euo pipefail

matches="$(grep -rnI --include='*.test.ts' --include='*.test.tsx' -E 'QUARANTINE\([^)]*\)' apps packages 2>/dev/null || true)"

if [ -z "$matches" ]; then
  printf '## Quarantined tests\n\nNone -- every test is active.\n'
  exit 0
fi

printf '## Quarantined tests (%s)\n\n' "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
printf '| Location | Annotation |\n| --- | --- |\n'
# grep -n output is `path:lineno:content`. Split only the first two colons so colons inside the
# annotation (the date, `Owner:`) survive; then strip the comment marker and escape a literal pipe.
printf '%s\n' "$matches" | while IFS= read -r raw; do
  location="$(printf '%s' "$raw" | cut -d: -f1-2)"
  annotation="$(printf '%s' "$raw" | cut -d: -f3- | sed -E 's/^[[:space:]]*(\/\/|\/\*|\*|#)?[[:space:]]*//; s/\|/\\|/g')"
  printf '| `%s` | %s |\n' "$location" "$annotation"
done
