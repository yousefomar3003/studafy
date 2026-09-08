#!/usr/bin/env bash
# Weekly Postgres restore-and-verify drill (ST-265). Runs as the sole command of the
# infra/docker/backup-verify.Dockerfile image, inside the ECS task infra/terraform/modules/backup's
# restore_verify.tf registers. Proves three things every run, not just "a restore succeeded":
#   1. Restorability   - RestoreDBInstanceToPointInTime actually produces a usable instance.
#   2. Data fidelity   - the restored copy's row counts and content checksums match a baseline
#                        captured from the source immediately before the restore was requested.
#   3. RLS survival    - every tenant table's Row-Level Security configuration (enabled, forced,
#                        the tenant_isolation policy) is unchanged on the restored copy.
#
# RESTORE_TIME (optional): an explicit ISO-8601 timestamp, e.g. "2026-09-01T03:15:00Z". Unset (the
# weekly schedule's default) means "use the latest restorable time" — routine drift-minimizing
# verification. Set it to demonstrate PITR to an arbitrary point in dev
# (infra/deploy/scripts/postgres-restore-verify.sh --restore-time=...).
#
# Exits 0 (PASS) or 1 (FAIL/error) and always writes a JSON report to
# s3://$REPORT_BUCKET/$REPORT_PREFIX/<timestamp>.json before exiting, whichever happens.
set -euo pipefail

: "${AWS_REGION:?}" "${SOURCE_DB_INSTANCE_ID:?}" "${DB_SUBNET_GROUP_NAME:?}" \
  "${DB_SECURITY_GROUP_ID:?}" "${POSTGRES_CONNECTION_SECRET_ARN:?}" \
  "${REPORT_BUCKET:?}" "${REPORT_PREFIX:?}" "${NAME_PREFIX:?}"
RESTORE_TIME="${RESTORE_TIME:-}"

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
SCRATCH_ID="${NAME_PREFIX}-pg-verify-${RUN_ID}"
REPORT_FILE="/tmp/report-${RUN_ID}.json"
STATUS="FAIL"
FAILURE_REASON=""
SCRATCH_CREATED=0

log() { echo "[postgres-restore-verify] $*" >&2; }

# Runs on every exit path (success, `set -e` failure, or an explicit `exit`) so a failed drill never
# leaves a billable scratch instance running unattended, and a report is always uploaded even when
# the drill itself blew up partway through.
cleanup() {
  if [ "$SCRATCH_CREATED" = "1" ]; then
    log "deleting scratch instance $SCRATCH_ID"
    aws rds delete-db-instance \
      --db-instance-identifier "$SCRATCH_ID" \
      --skip-final-snapshot \
      --region "$AWS_REGION" >/dev/null 2>&1 || log "WARNING: failed to delete $SCRATCH_ID — needs manual cleanup"
  fi

  if [ -f "$REPORT_FILE" ]; then
    aws s3 cp "$REPORT_FILE" "s3://${REPORT_BUCKET}/${REPORT_PREFIX}/${RUN_ID}.json" --region "$AWS_REGION" \
      || log "WARNING: failed to upload report to s3://${REPORT_BUCKET}/${REPORT_PREFIX}/${RUN_ID}.json"
  fi

  if [ "$STATUS" != "PASS" ]; then
    log "RESULT: FAIL ${FAILURE_REASON}"
    exit 1
  fi
  log "RESULT: PASS"
}
trap cleanup EXIT

fail() {
  FAILURE_REASON="$1"
  exit 1
}

SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$POSTGRES_CONNECTION_SECRET_ARN" \
  --region "$AWS_REGION" --query SecretString --output text)"
export PGUSER PGPASSWORD PGSSLMODE=require
PGUSER="$(jq -r '.username' <<<"$SECRET_JSON")"
PGPASSWORD="$(jq -r '.password' <<<"$SECRET_JSON")"
PGDATABASE="$(jq -r '.dbname' <<<"$SECRET_JSON")"
PGPORT="$(jq -r '.port' <<<"$SECRET_JSON")"
export PGDATABASE PGPORT
SOURCE_HOST="$(jq -r '.host' <<<"$SECRET_JSON")"

# psql -tAc: tuples-only, unaligned — output is bash/jq-friendly with no header/padding to strip.
psql_query() { PGHOST="$1" psql -tAc "$2"; }

# One query captures every tenant table's identity and RLS metadata in one round trip: name,
# whether RLS is enabled/forced, and whether the exact tenant_isolation policy this restore must
# have preserved (db/migrations/000006_create_rls_helper.sql) is still present.
TENANT_TABLE_QUERY="
  SELECT c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' ||
         EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'school_id' AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'app' AND c.relkind = 'r'
  ORDER BY c.relname;
"

# Order-independent per-table fingerprint: count(*) plus a commutative sum of a hash derived from
# each row's text representation. Two datasets with the same rows (any order) produce the same sum;
# a single differing/missing/extra row changes it. Cheap enough to run per table on a weekly job.
table_fingerprint() {
  psql_query "$1" "SELECT count(*) || '|' || coalesce(sum(('x' || substr(md5(t::text), 1, 16))::bit(64)::bigint), 0) FROM app.\"$2\" t;"
}

log "capturing baseline from source $SOURCE_DB_INSTANCE_ID ($SOURCE_HOST) before requesting the restore"
mapfile -t SOURCE_TABLES < <(psql_query "$SOURCE_HOST" "$TENANT_TABLE_QUERY")

declare -A SOURCE_FINGERPRINT
for row in "${SOURCE_TABLES[@]}"; do
  table="${row%%|*}"
  SOURCE_FINGERPRINT["$table"]="$(table_fingerprint "$SOURCE_HOST" "$table")"
done

log "requesting restore of $SCRATCH_ID from $SOURCE_DB_INSTANCE_ID (${RESTORE_TIME:-latest restorable time})"
RESTORE_ARGS=(
  --source-db-instance-identifier "$SOURCE_DB_INSTANCE_ID"
  --target-db-instance-identifier "$SCRATCH_ID"
  --db-subnet-group-name "$DB_SUBNET_GROUP_NAME"
  --vpc-security-group-ids "$DB_SECURITY_GROUP_ID"
  --no-multi-az
  --no-publicly-accessible
  --region "$AWS_REGION"
  --tags "Key=Purpose,Value=restore-verify" "Key=RunId,Value=${RUN_ID}"
)
if [ -n "$RESTORE_TIME" ]; then
  RESTORE_ARGS+=(--restore-time "$RESTORE_TIME")
else
  RESTORE_ARGS+=(--use-latest-restorable-time)
fi

aws rds restore-db-instance-to-point-in-time "${RESTORE_ARGS[@]}" >/dev/null || fail "restore-db-instance-to-point-in-time failed"
SCRATCH_CREATED=1

log "waiting for $SCRATCH_ID to become available (this is the slow step, typically 10-20 minutes)"
aws rds wait db-instance-available --db-instance-identifier "$SCRATCH_ID" --region "$AWS_REGION" \
  || fail "scratch instance never became available"

SCRATCH_HOST="$(aws rds describe-db-instances --db-instance-identifier "$SCRATCH_ID" --region "$AWS_REGION" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"

log "restore complete: $SCRATCH_ID at $SCRATCH_HOST — running verification"
mapfile -t SCRATCH_TABLES < <(psql_query "$SCRATCH_HOST" "$TENANT_TABLE_QUERY")

declare -a TABLE_REPORTS
ALL_PASS=1
for row in "${SCRATCH_TABLES[@]}"; do
  IFS='|' read -r table rls_enabled rls_forced has_policy <<<"$row"

  baseline="${SOURCE_FINGERPRINT[$table]:-}"
  current="$(table_fingerprint "$SCRATCH_HOST" "$table")"
  fingerprint_match="false"
  [ -n "$baseline" ] && [ "$baseline" = "$current" ] && fingerprint_match="true"

  rls_intact="false"
  [ "$rls_enabled" = "t" ] && [ "$rls_forced" = "t" ] && [ "$has_policy" = "t" ] && rls_intact="true"

  if [ "$fingerprint_match" != "true" ] || [ "$rls_intact" != "true" ]; then
    ALL_PASS=0
  fi

  TABLE_REPORTS+=("$(jq -n \
    --arg table "$table" \
    --arg baseline "$baseline" \
    --arg current "$current" \
    --argjson fingerprint_match "$fingerprint_match" \
    --argjson rls_enabled "$([ "$rls_enabled" = "t" ] && echo true || echo false)" \
    --argjson rls_forced "$([ "$rls_forced" = "t" ] && echo true || echo false)" \
    --argjson rls_policy_present "$([ "$has_policy" = "t" ] && echo true || echo false)" \
    '{table: $table, source_fingerprint: $baseline, scratch_fingerprint: $current,
      fingerprint_match: $fingerprint_match, rls_enabled: $rls_enabled, rls_forced: $rls_forced,
      rls_policy_present: $rls_policy_present}')")
done

jq -n \
  --arg run_id "$RUN_ID" \
  --arg source_instance "$SOURCE_DB_INSTANCE_ID" \
  --arg scratch_instance "$SCRATCH_ID" \
  --arg restore_time "${RESTORE_TIME:-latest-restorable-time}" \
  --argjson tables "[$(IFS=,; echo "${TABLE_REPORTS[*]}")]" \
  --argjson overall_pass "$([ "$ALL_PASS" = "1" ] && echo true || echo false)" \
  '{run_id: $run_id, source_instance: $source_instance, scratch_instance: $scratch_instance,
    restore_time: $restore_time, tables: $tables,
    status: ($overall_pass | if . then "PASS" else "FAIL" end)}' > "$REPORT_FILE"

if [ "$ALL_PASS" = "1" ]; then
  STATUS="PASS"
else
  FAILURE_REASON="one or more tables failed fingerprint or RLS verification — see $REPORT_FILE"
fi
