#!/usr/bin/env bash
# Monthly ERPNext restore drill (ST-265): proves a real site backup (erpnext-backup.sh's output)
# actually restores, not just that it was produced. Drills the FIRST site in SITE_HOSTNAMES only —
# one real restore proving the mechanism works beats a monthly job that tries to cover every tenant
# and takes proportionally longer; rotate which site is first in the list if broader coverage over
# time is wanted. Not a scratch RDS instance: unlike Postgres's restore_verify.tf, this drill
# restores into a new site (a new logical MariaDB database) on the SAME MariaDB instance, the exact
# mechanism infra/deploy/scripts/erpnext-new-site.sh already uses to provision every real school —
# spinning up a whole second MariaDB instance would exercise RDS's own restore path (already covered
# generically for both engines by modules/backup/main.tf's AWS Backup selection and
# replication.tf's cross-region replication) instead of the bench-level backup/restore path this
# specific acceptance criterion asks about.
set -euo pipefail

: "${REPORT_BUCKET:?}" "${MARIADB_CONNECTION_SECRET_ARN:?}"
SITE_HOSTNAMES="${SITE_HOSTNAMES:-}"
DRILL_SITE="restore-drill.internal"

log() { echo "[erpnext-restore-drill] $*" >&2; }

if [ -z "$SITE_HOSTNAMES" ]; then
  log "no sites configured (var.erpnext_site_hostnames is empty) — nothing to drill"
  exit 0
fi
SOURCE_SITE="$(echo "$SITE_HOSTNAMES" | cut -d' ' -f1)"

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
WORKDIR="/tmp/restore-drill-${RUN_ID}"
mkdir -p "$WORKDIR"
REPORT_FILE="/tmp/erpnext-restore-drill-${RUN_ID}.json"
STATUS="FAIL"
STEP="init"
DRILL_SITE_CREATED=0

SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$MARIADB_CONNECTION_SECRET_ARN" --query SecretString --output text)"
ROOT_USER="$(jq -r '.username' <<<"$SECRET_JSON")"
ROOT_PASSWORD="$(jq -r '.password' <<<"$SECRET_JSON")"

cleanup() {
  if [ "$DRILL_SITE_CREATED" = "1" ]; then
    log "dropping scratch site $DRILL_SITE"
    bench drop-site "$DRILL_SITE" \
      --mariadb-root-username "$ROOT_USER" --mariadb-root-password "$ROOT_PASSWORD" \
      --no-backup --force >/dev/null 2>&1 || log "WARNING: failed to drop $DRILL_SITE — needs manual cleanup"
  fi
  rm -rf "$WORKDIR"

  jq -n --arg run_id "$RUN_ID" --arg site "$SOURCE_SITE" --arg status "$STATUS" --arg failed_step "$STEP" \
    '{run_id: $run_id, source_site: $site, status: $status} + (if $status == "PASS" then {} else {failed_step: $failed_step} end)' \
    > "$REPORT_FILE"
  aws s3 cp "$REPORT_FILE" "s3://${REPORT_BUCKET}/reports/erpnext/restore-drill/${RUN_ID}.json" \
    || log "WARNING: failed to upload report"

  [ "$STATUS" = "PASS" ]
}
trap cleanup EXIT

log "finding the latest backup for $SOURCE_SITE in s3://${REPORT_BUCKET}/erpnext/${SOURCE_SITE}/"
STEP="find-latest-backup"
LATEST_PREFIX="$(aws s3api list-objects-v2 --bucket "$REPORT_BUCKET" --prefix "erpnext/${SOURCE_SITE}/" --delimiter / \
  --query 'CommonPrefixes[].Prefix' --output text | tr '\t' '\n' | sort | tail -n1)"
[ -n "$LATEST_PREFIX" ] || { log "no backups found for $SOURCE_SITE"; exit 1; }

log "downloading $LATEST_PREFIX"
aws s3 sync "s3://${REPORT_BUCKET}/${LATEST_PREFIX}" "$WORKDIR" --no-progress

DB_DUMP="$(find "$WORKDIR" -name '*-database.sql.gz' | head -n1)"
PRIVATE_FILES="$(find "$WORKDIR" -name '*-private-files.tar' | head -n1)"
PUBLIC_FILES="$(find "$WORKDIR" -name '*-files.tar' ! -name '*-private-files.tar' | head -n1)"
[ -n "$DB_DUMP" ] || { STEP="find-latest-backup"; log "no database dump in $LATEST_PREFIX"; exit 1; }

STEP="new-site"
log "creating scratch site $DRILL_SITE"
bench new-site "$DRILL_SITE" \
  --mariadb-root-username "$ROOT_USER" --mariadb-root-password "$ROOT_PASSWORD" \
  --admin-password "restore-drill-not-a-real-credential" --no-mariadb-socket
DRILL_SITE_CREATED=1

STEP="restore"
log "restoring $DB_DUMP into $DRILL_SITE"
RESTORE_ARGS=(--site "$DRILL_SITE" restore "$DB_DUMP" --mariadb-root-username "$ROOT_USER" --mariadb-root-password "$ROOT_PASSWORD")
[ -n "$PUBLIC_FILES" ] && RESTORE_ARGS+=(--with-public-files "$PUBLIC_FILES")
[ -n "$PRIVATE_FILES" ] && RESTORE_ARGS+=(--with-private-files "$PRIVATE_FILES")
bench "${RESTORE_ARGS[@]}"

STEP="doctor"
log "running bench doctor against the restored site"
bench --site "$DRILL_SITE" doctor

STEP="row-count-check"
log "confirming at least one restored row is actually readable"
USER_COUNT="$(bench --site "$DRILL_SITE" mariadb --execute "SELECT COUNT(*) FROM tabUser;" --silent --skip-column-names)"
[ "${USER_COUNT:-0}" -gt 0 ] || { log "restored site has zero rows in tabUser — restore did not actually load data"; exit 1; }

STATUS="PASS"
