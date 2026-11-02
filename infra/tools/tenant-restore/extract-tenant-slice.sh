#!/usr/bin/env bash
# Phase B of the tenant-slice restore tool (ST-267): pulls every row belonging to one school_id out
# of a Postgres instance -- normally the scratch instance restore-scratch.sh just restored, so this
# is read against a point-in-time copy, never against live prod -- and writes it to a portable,
# checksummed slice on local disk (data/<table>.sql, one per table, plain INSERT statements) plus a
# manifest.json audit record. apply-tenant-slice.sh is the only thing that reads what this script
# writes.
#
# Why INSERT statements and not COPY: apply-tenant-slice.sh's write path found out the hard way
# (see this directory's README) that PostgreSQL unconditionally refuses `COPY ... FROM` against a
# row-security-enabled table for any role that doesn't bypass RLS entirely -- regardless of
# policies, regardless of SET ROLE. INSERT has no such restriction; a row that satisfies the
# tenant_isolation policy's WITH CHECK is accepted normally. So this script generates
# `pg_dump --data-only --column-inserts`, one table at a time.
#
# How the school_id filter is enforced: not a hand-written WHERE clause. This script requires the
# connected role to `SET ROLE studafy_admin` (probed by lib/common.sh's
# can_set_role_studafy_admin -- hard failure if it can't, see README's Known gaps) and passes
# `app.school_id` as a PGOPTIONS startup GUC. app.apply_tenant_isolation's own FORCE ROW LEVEL
# SECURITY (db/migrations/000006) then filters every table to exactly this tenant, the same
# mechanism apps/api's own withSystemTx + setTenantScope rely on
# (apps/api/src/db/tenant-tx.ts) -- plus `--enable-row-security`, which pg_dump otherwise requires
# before it will even honor RLS filtering as the table owner (without it, pg_dump refuses to dump
# an owned table it suspects RLS would filter, rather than silently produce a partial dump).
#
# `app.user_id` is also set, to a real ORG_ADMIN/SUPER_ADMIN user of this school (looked up below),
# because a large share of tenant tables layer a second, narrower `role_scope_visibility` policy on
# top of tenant_isolation (db/migrations/000037) whose functions (app.can_read_class,
# app.teaches_class, ...) call app.current_user_id(), which -- unlike app.scope_user_id() --
# raises "unrecognized configuration parameter" if app.user_id was never set at all, empty table or
# not. Using a real admin lets that policy's own `current_user_is_school_admin()` escape hatch
# grant full visibility, the same as it would for a human admin.
#
# Not every such policy has that escape hatch -- db/migrations/000014's teacher_evaluation_visibility
# deliberately does not (a teacher evaluation is visible only to the teacher being evaluated or the
# evaluator, never to a generic admin). For a table like that, an independent row count from a
# plain `SELECT count(*) ... WHERE school_id = ...` -- which does not depend on any RLS policy at
# all -- is compared against pg_dump's own INSERT count for every table as a cross-check. A real
# mismatch means this tool cannot see 100% of that table's rows for this school through any role it
# has, and it fails loudly rather than shipping a silently incomplete or cross-tenant slice. See
# this directory's README, "Known gaps", for what to do when that happens.
#
# Usage:
#   extract-tenant-slice.sh --school-id <uuid> --out-dir <dir> [--ticket <id>]
#     [--include-table <name>]... [--exclude-table <name>]...
#
# Connection: see lib/common.sh's resolve_pg_connection -- either CONNECTION_SECRET_ARN+AWS_REGION
# (+ PGHOST_OVERRIDE pointed at the scratch instance) or plain PGHOST/PGPORT/PGUSER/PGPASSWORD/
# PGDATABASE.
#
# Optional S3 audit upload: set REPORT_BUCKET (and optionally REPORT_PREFIX, default
# "tenant-restore") to also upload data/ and manifest.json to
# s3://$REPORT_BUCKET/$REPORT_PREFIX/<run-id>/ -- the same bucket/prefix
# infra/terraform/modules/backup/tenant_restore.tf scopes the tenant-restore-operator role's
# s3:PutObject grant to.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

SCHOOL_ID=""
OUT_DIR=""
TICKET=""
declare -a INCLUDE_TABLES=()
declare -a EXCLUDE_TABLES=()

usage() {
  cat >&2 <<'EOF'
Usage: extract-tenant-slice.sh --school-id <uuid> --out-dir <dir> [--ticket <id>]
         [--include-table <name>]... [--exclude-table <name>]...
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --school-id) SCHOOL_ID="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    --include-table) INCLUDE_TABLES+=("$2"); shift 2 ;;
    --exclude-table) EXCLUDE_TABLES+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

[ -n "$SCHOOL_ID" ] || { usage; fail "--school-id is required"; }
[ -n "$OUT_DIR" ] || { usage; fail "--out-dir is required"; }
require_uuid "$SCHOOL_ID" "--school-id"

resolve_pg_connection

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
DATA_DIR="$OUT_DIR/data"
MANIFEST_FILE="$OUT_DIR/manifest.json"
mkdir -p "$DATA_DIR"

log "looking up school $SCHOOL_ID on $PGHOST/$PGDATABASE"
SCHOOL_NAME="$(psql -tAc "SELECT name FROM app.schools WHERE id = '$SCHOOL_ID'")"
[ -n "$SCHOOL_NAME" ] || fail "no school with id $SCHOOL_ID found on $PGHOST/$PGDATABASE -- wrong instance, or the school row itself is what's missing (that is app.schools' own row, not a slice this tool can rebuild)"
log "school '$SCHOOL_NAME' found -- extracting its tenant-table slice"

can_set_role_studafy_admin \
  || fail "connected role cannot SET ROLE studafy_admin on $PGHOST/$PGDATABASE -- required so RLS can filter this extraction to exactly one tenant (see README's Known gaps); refusing to fall back to an unfiltered read"

ADMIN_USER_ID="$(psql -tA \
  -c "SELECT set_config('app.school_id', '$SCHOOL_ID', false)" \
  -c "SELECT ur.user_id FROM app.user_roles ur WHERE ur.school_id = '$SCHOOL_ID' AND ur.role IN ('ORG_ADMIN', 'SUPER_ADMIN') ORDER BY ur.user_id LIMIT 1" \
  | tail -n1)"
[ -n "$ADMIN_USER_ID" ] \
  || fail "no ORG_ADMIN/SUPER_ADMIN user_role found for school $SCHOOL_ID -- extraction needs one real admin user to satisfy admin-scoped RLS visibility checks (see this script's header comment)"
log "using admin user $ADMIN_USER_ID as the extraction actor for role-scoped visibility checks"
export PGOPTIONS="-c app.school_id=$SCHOOL_ID -c app.user_id=$ADMIN_USER_ID"

# Build the effective table list: discovered tenant tables, minus the default exclusions, minus
# any --exclude-table, plus any --include-table (which can re-add a default-excluded table --
# operator judgment call, logged either way in the manifest).
mapfile -t DEFAULT_EXCLUDED < <(load_default_excluded_tables "$SCRIPT_DIR/lib")
declare -A SKIP=()
for t in "${DEFAULT_EXCLUDED[@]}" "${EXCLUDE_TABLES[@]:-}"; do
  [ -n "$t" ] && SKIP["$t"]=1
done
for t in "${INCLUDE_TABLES[@]:-}"; do
  [ -n "$t" ] && unset 'SKIP[$t]'
done

declare -a TABLE_RECORDS=()
declare -a SKIPPED_RECORDS=()
TOTAL_ROWS=0

while IFS=$'\t' read -r table lvl is_partitioned; do
  [ -n "$table" ] || continue
  if [ -n "${SKIP[$table]:-}" ]; then
    log "skipping $table (default-excluded; pass --include-table $table to override)"
    SKIPPED_RECORDS+=("$(jq -n --arg t "$table" '{table: $t, reason: "default-excluded, see lib/default-excluded-tables.txt"}')")
    continue
  fi

  file="$DATA_DIR/$table.sql"
  log "extracting $table (level $lvl)"

  # Independent of pg_dump/RLS entirely -- an explicit WHERE, used only as a cross-check below.
  expected_rows="$(psql -tAc "SELECT count(*) FROM app.\"$table\" WHERE school_id = '$SCHOOL_ID'")"

  # A partitioned parent's own data is always empty (rows live in its partitions); a bare
  # --table=app.<name> would silently dump zero rows. Widen to a name-prefix pattern so pg_dump
  # also matches every partition (see discover-tenant-tables.sql's is_partitioned comment).
  table_pattern="app.$table"
  [ "$is_partitioned" = "t" ] && table_pattern="app.$table*"

  pg_dump --data-only --column-inserts --no-owner --no-privileges --enable-row-security \
    --role=studafy_admin --table="$table_pattern" --file="$file" \
    || fail "pg_dump failed for $table"

  actual_rows="$(grep -c '^INSERT INTO ' "$file" || true)"
  [ "$actual_rows" = "$expected_rows" ] \
    || fail "$table: pg_dump produced $actual_rows INSERT statement(s) but an explicit WHERE school_id count says $expected_rows -- this table's RLS policy is not fully visible to admin user $ADMIN_USER_ID (see this script's header comment on tables like teacher_evaluations); aborting rather than shipping a possibly incomplete slice"

  checksum="$(sha256_file "$file")"
  TOTAL_ROWS=$((TOTAL_ROWS + expected_rows))
  TABLE_RECORDS+=("$(jq -n \
    --arg table "$table" --argjson lvl "$lvl" --argjson rows "$expected_rows" \
    --arg sha256 "$checksum" --arg file "data/$table.sql" \
    '{table: $table, level: $lvl, row_count: $rows, sha256: $sha256, file: $file}')")
done < <(discover_tenant_tables "$SCRIPT_DIR/lib")

[ "${#TABLE_RECORDS[@]}" -gt 0 ] || fail "no tenant tables extracted -- discovery query returned nothing"

OPERATOR="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo "unknown (aws sts get-caller-identity unavailable)")"

jq -n \
  --arg run_id "$RUN_ID" \
  --arg school_id "$SCHOOL_ID" \
  --arg school_name "$SCHOOL_NAME" \
  --arg source_host "$PGHOST" \
  --arg source_database "$PGDATABASE" \
  --arg ticket "$TICKET" \
  --arg operator "$OPERATOR" \
  --arg extraction_actor_user_id "$ADMIN_USER_ID" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg format "sql-insert" \
  --argjson total_rows "$TOTAL_ROWS" \
  --argjson tables "[$(IFS=,; echo "${TABLE_RECORDS[*]}")]" \
  --argjson skipped "[$(IFS=,; echo "${SKIPPED_RECORDS[*]:-}")]" \
  '{run_id: $run_id, school_id: $school_id, school_name: $school_name, source_host: $source_host,
    source_database: $source_database, ticket: $ticket, operator: $operator,
    extraction_actor_user_id: $extraction_actor_user_id, created_at: $created_at, format: $format,
    total_rows: $total_rows, tables: $tables, skipped_tables: $skipped}' > "$MANIFEST_FILE"

log "extracted ${#TABLE_RECORDS[@]} tables, $TOTAL_ROWS rows -> $OUT_DIR"
log "manifest: $MANIFEST_FILE"

if [ -n "${REPORT_BUCKET:-}" ]; then
  prefix="${REPORT_PREFIX:-tenant-restore}/$RUN_ID"
  log "uploading slice to s3://$REPORT_BUCKET/$prefix/"
  aws s3 cp "$OUT_DIR" "s3://$REPORT_BUCKET/$prefix/" --recursive \
    || fail "extracted slice is on local disk at $OUT_DIR but the S3 audit upload failed -- do not proceed to apply-tenant-slice.sh until this run is recorded in the audit bucket"
  log "uploaded to s3://$REPORT_BUCKET/$prefix/"
fi
