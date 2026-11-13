#!/usr/bin/env bash
# Corruption drill for run-integrity-check.sh. Injects one real violation of each integrity-check
# category into a disposable local database, proves the console detects every category at once,
# cleans up, and proves the console is clean again on a re-run.
#
#   drill-corruption.sh [--school-slug <slug>] [--check <name>]...
#
# Defaults to the demo tenant, studafy-demo-academy. With --check, only the named check(s) are
# asserted to detect their corruption (all four corruptions are still injected and cleaned up).
#
# Injections (each one is exactly what its check is designed to catch, never something the schema
# would accept through normal channels):
#   orphaned-links                 an invoice_cache row whose student_id references nothing,
#                                  inserted under session_replication_role = replica so the FK
#                                  trigger under test is bypassed (the enforcement that scan defeats)
#   enrollment-invoice-consistency deletion of the only enrollment of an invoiced student
#   grade-weight-sums              two active assessment categories (50 + 30) on one gradebook,
#                                  active weight total 80, not 100
#   rls-spot-probes                ALTER TABLE app.students DISABLE ROW LEVEL SECURITY (a
#                                  superuser-only act the catalogue and fail-open probes see)
#
# SAFETY: this script corrupts and deletes rows, so it refuses to run unless (a) PGHOST is a
# recognized loopback host (same list db/seeds/guard.ts trusts; override with INTEGRITY_ALLOW_NONLOCAL
# only for a disposable remote CI database), (b) the connected role is a superuser (needed for
# session_replication_role and the RLS-disabling ALTER), and (c) the connected role can SET ROLE
# studafy_app, like the console itself. A trap undoes whatever was injected on any exit path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

SCHOOL_SLUG="studafy-demo-academy"
declare -a CHECK_NAMES=()

usage() {
  cat >&2 <<'EOF'
Usage: drill-corruption.sh [--school-slug <slug>] [--check <name>]...
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --school-slug) SCHOOL_SLUG="$2"; shift 2 ;;
    --check) CHECK_NAMES+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

ALL_CHECKS=(orphaned-links enrollment-invoice-consistency grade-weight-sums rls-spot-probes)
if [ "${#CHECK_NAMES[@]}" -gt 0 ]; then
  for c in "${CHECK_NAMES[@]}"; do
    printf '%s\n' "${ALL_CHECKS[@]}" | grep -qx -- "$c" \
      || { echo "unknown check: $c (expected one of: ${ALL_CHECKS[*]})" >&2; usage; exit 2; }
  done
  RUN_CHECKS=("${CHECK_NAMES[@]}")
else
  RUN_CHECKS=("${ALL_CHECKS[@]}")
fi

resolve_pg_connection
require_loopback_host
require_superuser
can_set_role_studafy_app \
  || fail "connected role cannot SET ROLE studafy_app on $PGHOST/$PGDATABASE -- the console needs it for its RLS spot probes"

school_row="$(resolve_school "$SCHOOL_SLUG" "")"
SCHOOL_ID="$(printf '%s' "$school_row" | cut -f1)"
SCHOOL_SLUG="$(printf '%s' "$school_row" | cut -f2)"
SCHOOL_NAME="$(printf '%s' "$school_row" | cut -f3)"
log "corruption drill against $SCHOOL_NAME ($SCHOOL_SLUG) on $PGHOST/$PGDATABASE"

TMP_DIR="$(mktemp -d)"
BASELINE_REPORT="$TMP_DIR/baseline.json"
CORRUPT_REPORT="$TMP_DIR/corrupt.json"
CLEAN_REPORT="$TMP_DIR/clean.json"

INJECTED_ORPHAN=0
INJECTED_ENROLLMENT=0
INJECTED_WEIGHT=0
INJECTED_RLS=0
ENROLLMENT_JSON=""

# Undoes every injection this run performed. Every statement is idempotent (a second run against a
# fully cleaned database is a no-op), so the EXIT trap can fire it again on exit harmlessly.
cleanup_corruption() {
  if [ "$INJECTED_ORPHAN" = "1" ]; then
    psql -X -v ON_ERROR_STOP=1 \
      -c "DELETE FROM app.invoice_cache WHERE school_id = '$SCHOOL_ID' AND erpnext_docname LIKE 'DRILL-%'" \
      >/dev/null 2>&1 || true
  fi
  if [ "$INJECTED_ENROLLMENT" = "1" ] && [ -n "$ENROLLMENT_JSON" ]; then
    local withdrawn_sql school class student status enrolled created updated
    school="$(jq -r '.school_id' <<<"$ENROLLMENT_JSON")"
    class="$(jq -r '.class_id' <<<"$ENROLLMENT_JSON")"
    student="$(jq -r '.student_id' <<<"$ENROLLMENT_JSON")"
    status="$(jq -r '.status' <<<"$ENROLLMENT_JSON")"
    enrolled="$(jq -r '.enrolled_at' <<<"$ENROLLMENT_JSON")"
    created="$(jq -r '.created_at' <<<"$ENROLLMENT_JSON")"
    updated="$(jq -r '.updated_at' <<<"$ENROLLMENT_JSON")"
    if [ "$(jq -r '.withdrawn_at' <<<"$ENROLLMENT_JSON")" = "null" ]; then
      withdrawn_sql="NULL"
    else
      withdrawn_sql="'$(jq -r '.withdrawn_at' <<<"$ENROLLMENT_JSON")'"
    fi
    psql -X -v ON_ERROR_STOP=1 \
      -c "INSERT INTO app.enrollments (school_id, class_id, student_id, status, enrolled_at, withdrawn_at, created_at, updated_at) VALUES ('$school', '$class', '$student', '$status', '$enrolled', $withdrawn_sql, '$created', '$updated') ON CONFLICT (school_id, class_id, student_id) DO NOTHING" \
      >/dev/null 2>&1 || true
  fi
  if [ "$INJECTED_WEIGHT" = "1" ]; then
    psql -X -v ON_ERROR_STOP=1 \
      -c "DELETE FROM app.assessment_categories WHERE school_id = '$SCHOOL_ID' AND name IN ('Drill Weight A', 'Drill Weight B')" \
      >/dev/null 2>&1 || true
  fi
  if [ "$INJECTED_RLS" = "1" ]; then
    psql -X -v ON_ERROR_STOP=1 \
      -c "ALTER TABLE app.students ENABLE ROW LEVEL SECURITY" \
      -c "ALTER TABLE app.students FORCE ROW LEVEL SECURITY" \
      >/dev/null 2>&1 || true
  fi
}
trap 'cleanup_corruption; rm -rf "$TMP_DIR"' EXIT

run_integrity() {
  local report="$1"
  local rc=0
  local -a args=(--school-slug "$SCHOOL_SLUG" --report "$report")
  for c in "${RUN_CHECKS[@]}"; do
    args+=(--check "$c")
  done
  set +e
  "$SCRIPT_DIR/run-integrity-check.sh" "${args[@]}"
  rc=$?
  set -e
  return $rc
}

# Phase 0: baseline must already be clean -- otherwise the drill cannot tell its own corruption from
# pre-existing damage, and it refuses to touch the data.
log "phase 0: baseline run must be clean"
run_integrity "$BASELINE_REPORT" \
  || fail "baseline integrity run is not clean ($BASELINE_REPORT) -- fix the pre-existing findings before running the drill"
log "baseline clean"

# Phase 1: inject one violation per check category.
log "injecting orphaned invoice_cache row (FK-bypassed student reference)"
INJECTED_ORPHAN=1
psql -X -v ON_ERROR_STOP=1 \
  -c "SET session_replication_role = replica" \
  -c "INSERT INTO app.invoice_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at) SELECT s.id, '00000000-0000-0000-0000-0000dead0001', s.default_currency_id, 'DRILL-ORPHAN-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 8), 'Paid', 1, 0, CURRENT_DATE, CURRENT_TIMESTAMP FROM app.schools AS s WHERE s.id = '$SCHOOL_ID'" \
  || fail "orphaned-links injection failed"
log "  injected DRILL-ORPHAN-* invoice row with a nonexistent student_id"

log "injecting enrollment deletion (invoiced student's only enrollment)"
INJECTED_ENROLLMENT=1
TARGET_STUDENT="$(psql -tA -v ON_ERROR_STOP=1 -c \
  "SELECT e.student_id FROM app.enrollments AS e JOIN app.invoice_cache AS i ON i.student_id = e.student_id AND i.school_id = e.school_id WHERE e.school_id = '$SCHOOL_ID' GROUP BY e.student_id HAVING count(*) = 1 ORDER BY e.student_id LIMIT 1" \
  | tail -n1)"
[ -n "$TARGET_STUDENT" ] || fail "no invoiced student with exactly one enrollment found -- injection cannot proceed"
ENROLLMENT_JSON="$(psql -tA -v ON_ERROR_STOP=1 -c \
  "SELECT json_build_object('school_id', e.school_id, 'class_id', e.class_id, 'student_id', e.student_id, 'status', e.status, 'enrolled_at', e.enrolled_at, 'withdrawn_at', e.withdrawn_at, 'created_at', e.created_at, 'updated_at', e.updated_at) FROM app.enrollments AS e WHERE e.school_id = '$SCHOOL_ID' AND e.student_id = '$TARGET_STUDENT'" \
  | tail -n1)"
[ -n "$ENROLLMENT_JSON" ] || fail "failed to capture enrollment row to restore"
psql -X -v ON_ERROR_STOP=1 \
  -c "SET session_replication_role = replica" \
  -c "DELETE FROM app.enrollments WHERE school_id = '$SCHOOL_ID' AND student_id = '$TARGET_STUDENT'" \
  -c "SET session_replication_role = default" \
  || fail "enrollment-invoice-consistency injection failed"
log "  deleted the only enrollment of invoiced student $TARGET_STUDENT"

log "injecting mis-weighted assessment categories (50 + 30)"
INJECTED_WEIGHT=1
DRILL_GRADEBOOK="$(psql -tA -v ON_ERROR_STOP=1 -c \
  "SELECT id FROM app.gradebooks WHERE school_id = '$SCHOOL_ID' ORDER BY id LIMIT 1" \
  | tail -n1)"
[ -n "$DRILL_GRADEBOOK" ] || fail "no gradebook exists for this school -- grade-weight-sums injection cannot proceed"
psql -X -v ON_ERROR_STOP=1 \
  -c "INSERT INTO app.assessment_categories (school_id, gradebook_id, name, weight, sort_order, is_active) VALUES ('$SCHOOL_ID', '$DRILL_GRADEBOOK', 'Drill Weight A', 50, 0, true)" \
  -c "INSERT INTO app.assessment_categories (school_id, gradebook_id, name, weight, sort_order, is_active) VALUES ('$SCHOOL_ID', '$DRILL_GRADEBOOK', 'Drill Weight B', 30, 1, true)" \
  || fail "grade-weight-sums injection failed"
log "  active weight sum for gradebook $DRILL_GRADEBOOK is now 80"

log "injecting disabled RLS on app.students"
INJECTED_RLS=1
psql -X -v ON_ERROR_STOP=1 -c "ALTER TABLE app.students DISABLE ROW LEVEL SECURITY" \
  || fail "rls-spot-probes injection failed"
log "  app.students ROW LEVEL SECURITY disabled (catalogue probe and fail-open probe must both flag it)"

# Phase 2: the console must fail every asserted check -- with findings, not with an error.
log "phase 2: corrupt run must flag every asserted check"
if run_integrity "$CORRUPT_REPORT"; then
  corrupt_rc=0
else
  corrupt_rc=$?
fi
[ "$corrupt_rc" -ne 0 ] \
  || fail "corrupt run exited 0 ($CORRUPT_REPORT) -- none of the injected corruption was detected"
FAILED_CONFIRMED="$(jq -r '[.checks[] | select(.status == "fail") | .check] | sort | join(",")' "$CORRUPT_REPORT")"
FAILED_NONPASS="$(jq -r '[.checks[] | select(.status != "pass") | .check] | sort | join(",")' "$CORRUPT_REPORT")"
EXPECTED="$(printf '%s\n' "${RUN_CHECKS[@]}" | sort | paste -sd, -)"
[ "$FAILED_CONFIRMED" = "$EXPECTED" ] \
  || fail "corrupt run flagged: confirmed=$FAILED_CONFIRMED vs all-non-pass=$FAILED_NONPASS; expected every asserted check ($EXPECTED) to fail with findings -- a check that errored rather than detecting is a drill failure"
log "detected with findings: $FAILED_CONFIRMED"

# Phase 3: undo the injections explicitly (the EXIT trap still backs this up), then re-verify.
log "phase 3: cleaning injected corruption"
cleanup_corruption
log "phase 4: post-cleanup run must be clean again"
run_integrity "$CLEAN_REPORT" \
  || fail "post-cleanup integrity run is not clean ($CLEAN_REPORT) -- cleanup was incomplete, inspect and fix before re-running"
log "post-cleanup clean"

echo "RESULT: PASS"
exit 0