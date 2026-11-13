#!/usr/bin/env bash
# Runs one scenario, compares it against the last archived run, and archives this run regardless of
# outcome (a regressed or threshold-failing run is exactly the one worth keeping for later
# investigation). This is the one entrypoint CI or a human should call — not `k6 run` directly —
# because a bare `k6 run` skips both the regression comparison and the archive step.
#
# Usage:
#   scripts/run.sh <scenario> [-- k6-args...]
#   scripts/run.sh morning-attendance-peak
#   TARGET_ENV=staging TEACHERS_FILE=./data/teachers.json scripts/run.sh morning-attendance-peak
#
# Exit code is non-zero if k6 itself failed (a threshold breach or a runtime error) OR — unless
# REGRESSION_STRICT=0 — if scripts/compare-regression.mjs found a regression against the last
# archived run. Either way the report is archived first, so a failing CI run still leaves a report
# to look at.
set -euo pipefail

SCENARIO="${1:?usage: run.sh <scenario> [k6-args...]}"
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCENARIO_FILE="$ROOT_DIR/scenarios/$SCENARIO.js"

if [ ! -f "$SCENARIO_FILE" ]; then
  echo "No such scenario file: $SCENARIO_FILE" >&2
  echo "Available scenarios:" >&2
  ls "$ROOT_DIR/scenarios" | sed 's/\.js$//' | sed 's/^/  /' >&2
  exit 2
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is not installed. See https://grafana.com/docs/k6/latest/set-up/install-k6/ " \
    "(or run via the grafana/k6 Docker image)." >&2
  exit 2
fi

TMP_SUMMARY="$(mktemp "${TMPDIR:-/tmp}/k6-summary-XXXXXX.json")"
cleanup() { rm -f "$TMP_SUMMARY"; }
trap cleanup EXIT

echo "=== Running $SCENARIO against ${BASE_URL:-<TARGET_ENV=${TARGET_ENV:-local}>} ==="
set +e
k6 run --summary-export="$TMP_SUMMARY" "$SCENARIO_FILE" "$@"
K6_EXIT=$?
set -e

# Compare BEFORE archiving: compare-regression.mjs finds "the last run" by looking at what's
# already under reports/<scenario>/, so this run's own archive must not exist yet when it looks —
# otherwise it would find itself and always report "no regression".
echo "=== Regression comparison ==="
set +e
(cd "$ROOT_DIR" && bun scripts/compare-regression.mjs "$SCENARIO" "$TMP_SUMMARY")
COMPARE_EXIT=$?
set -e

echo "=== Archiving report ==="
(cd "$ROOT_DIR" && bun scripts/archive-report.mjs "$SCENARIO" "$TMP_SUMMARY" "$K6_EXIT")

if [ "$K6_EXIT" -ne 0 ]; then
  echo "k6 run failed — thresholds breached or a runtime error occurred. See output above." >&2
  exit "$K6_EXIT"
fi

if [ "$COMPARE_EXIT" -ne 0 ] && [ "${REGRESSION_STRICT:-1}" != "0" ]; then
  echo "Failing on regression (set REGRESSION_STRICT=0 to only warn)." >&2
  exit "$COMPARE_EXIT"
fi

exit 0
