#!/usr/bin/env bash
# Per-tenant data validation console. Runs a fixed set of integrity checks against one school's
# tables and writes a JSON report that can be attached to a support case.
#
#   run-integrity-check.sh --school-slug <slug> | --school-id <uuid>
#       [--check <name>]... [--report <path>]
#
# Checks (see lib/checks/ for the SQL and the rls-spot-probes library):
#   orphaned-links                    FK-orphan scan + ERPNext crosswalk (01-orphaned-links.sql)
#   enrollment-invoice-consistency    invoiced/paid students must be enrolled (02-*.sql)
#   grade-weight-sums                 active category weights total exactly 100 (03-*.sql)
#   rls-spot-probes                   4 behavioural/catalogue RLS probes (lib/checks/rls-*.sh + 04-*.sql)
#
# Exit status: 0 clean (every check pass), 1 any check failed or errored, 2 usage error.
#
# Connection: lib/common.sh's resolve_pg_connection -- CONNECTION_SECRET_ARN+AWS_REGION or plain
# PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. Data checks run as the connected role (superuser
# locally / RDS master) scoped to the school by the app.school_id session GUC plus an explicit
# school_id filter on every query, so a connected role that bypasses RLS still sees only this
# tenant. The RLS probes additionally SET ROLE studafy_app; the connected role must be able to
# (probed up front, hard failure otherwise -- see lib/common.sh can_set_role_studafy_app).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/checks/rls-spot-probes.sh
source "$SCRIPT_DIR/lib/checks/rls-spot-probes.sh"

SCHOOL_SLUG=""
SCHOOL_ID=""
declare -a CHECK_NAMES=()
REPORT_FILE=""

usage() {
  cat >&2 <<'EOF'
Usage: run-integrity-check.sh --school-slug <slug> | --school-id <uuid> [--check <name>]...
         [--report <path>]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --school-slug) SCHOOL_SLUG="$2"; shift 2 ;;
    --school-id) SCHOOL_ID="$2"; shift 2 ;;
    --check) CHECK_NAMES+=("$2"); shift 2 ;;
    --report) REPORT_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -n "$SCHOOL_SLUG" ] && [ -n "$SCHOOL_ID" ]; then
  echo "pass either --school-slug or --school-id, not both" >&2; usage; exit 2
fi
if [ -z "$SCHOOL_SLUG" ] && [ -z "$SCHOOL_ID" ]; then
  echo "one of --school-slug or --school-id is required" >&2; usage; exit 2
fi
[ -z "$SCHOOL_ID" ] || require_uuid "$SCHOOL_ID" "--school-id"

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

can_set_role_studafy_app \
  || fail "connected role cannot SET ROLE studafy_app on $PGHOST/$PGDATABASE -- required by the RLS spot probes (they must run as the exact role the API runs as); refusing to run without them"

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

school_row="$(resolve_school "$SCHOOL_SLUG" "$SCHOOL_ID")"
SCHOOL_ID="$(printf '%s' "$school_row" | cut -f1)"
SCHOOL_SLUG="$(printf '%s' "$school_row" | cut -f2)"
SCHOOL_NAME="$(printf '%s' "$school_row" | cut -f3)"
log "checks against $SCHOOL_NAME ($SCHOOL_SLUG, $SCHOOL_ID) on $PGHOST/$PGDATABASE"

ADMIN_USER_ID="$(resolve_admin_user_id "$SCHOOL_ID")"
log "using admin actor user $ADMIN_USER_ID for RLS spot probes"

[ -n "$REPORT_FILE" ] || REPORT_FILE="integrity-report-$SCHOOL_SLUG-$RUN_ID.json"

run_sql_check() {
  local check="$1" file="$2"
  local secs=$SECONDS rc=0 line=""
  line="$(psql -X -tA -v ON_ERROR_STOP=1 -v school_id="$SCHOOL_ID" -f "$file" 2>&1 | tail -n1)" || rc=$?
  local dur=$((SECONDS - secs))
  if [ "$rc" -ne 0 ]; then
    jq -n --arg c "$check" --arg d "psql failed for $check: $line" --argjson dur "$dur" \
      '{check: $c, status: "error", findings_count: 0, findings: [], summary: $d, duration_s: $dur}'
    return 0
  fi
  if ! printf '%s' "$line" | jq -e . >/dev/null 2>&1; then
    jq -n --arg c "$check" --arg d "check $check produced invalid JSON and could not be parsed: $line" --argjson dur "$dur" \
      '{check: $c, status: "error", findings_count: 0, findings: [], summary: $d, duration_s: $dur}'
    return 0
  fi
  printf '%s' "$line" | jq --arg c "$check" --argjson dur "$dur" \
    '. + {check: $c, duration_s: $dur}'
}

declare -A CHECK_FILE=(
  [orphaned-links]=lib/checks/01-orphaned-links.sql
  [enrollment-invoice-consistency]=lib/checks/02-enrollment-invoice-consistency.sql
  [grade-weight-sums]=lib/checks/03-grade-weight-sums.sql
)

declare -a CHECK_RECORDS=()
for c in "${RUN_CHECKS[@]}"; do
  log "running check: $c"
  if [ -n "${CHECK_FILE[$c]:-}" ]; then
    CHECK_RECORDS+=("$(run_sql_check "$c" "$SCRIPT_DIR/${CHECK_FILE[$c]}")")
  else
    secs=$SECONDS
    line="$(run_rls_spot_probes "$SCHOOL_ID" "$ADMIN_USER_ID" "$SCRIPT_DIR/lib/checks")"
    dur=$((SECONDS - secs))
    CHECK_RECORDS+=("$(printf '%s' "$line" | jq --argjson d "$dur" '. + {duration_s: $d}')")
  fi
done

REPORT="$(jq -n \
  --arg run_id "$RUN_ID" \
  --arg started_at "$STARTED_AT" \
  --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg host "${PGHOST:-}" \
  --arg database "${PGDATABASE:-}" \
  --arg school_id "$SCHOOL_ID" \
  --arg school_slug "$SCHOOL_SLUG" \
  --arg school_name "$SCHOOL_NAME" \
  --argjson checks "[$(IFS=,; echo "${CHECK_RECORDS[*]}")]" \
  '{tool: "integrity", run_id: $run_id, started_at: $started_at, finished_at: $finished_at,
    host: $host, database: $database,
    school: {id: $school_id, slug: $school_slug, name: $school_name},
    checks: $checks,
    result: (if any($checks[]; .status != "pass") then "fail" else "pass" end)}')"

printf '%s\n' "$REPORT" > "$REPORT_FILE"

RESULT="$(printf '%s' "$REPORT" | jq -r '.result')"
log "result: $RESULT -- report: $REPORT_FILE"
[ "$RESULT" = "pass" ] && exit 0 || exit 1