#!/usr/bin/env bash
# Nightly ERPNext site + database backup (ST-265). Runs as the "site-setup"-shaped one-off ECS task
# infra/terraform/modules/backup/erpnext_backup.tf registers, on the same bench image
# (infra/docker/erpnext.Dockerfile) the backend/websocket/queue/scheduler roles already use, mounting
# the same EFS `sites` access point read-write.
#
# `bench backup --with-files` is Frappe's own supported backup mechanism — the database dump plus
# the site's public/private files, in one Frappe-managed operation — which is exactly what the
# later restore drill (erpnext-restore-drill.sh) needs to restore from. A raw `mysqldump` would skip
# the files half and isn't what `bench restore` expects on the other end.
#
# SITE_HOSTNAMES: space-separated list of real site hostnames to back up (var.erpnext_site_hostnames
# joined by the Terraform task definition). Off-site retention: every backup this script produces is
# uploaded to S3 and then deleted from EFS — S3 (versioned, encrypted, cross-region-replicated at
# the bucket level like every other object in backups-archive) is the durable copy, not the shared
# bench filesystem every long-running service also depends on.
set -euo pipefail

: "${REPORT_BUCKET:?}"
SITE_HOSTNAMES="${SITE_HOSTNAMES:-}"

log() { echo "[erpnext-backup] $*" >&2; }

if [ -z "$SITE_HOSTNAMES" ]; then
  log "no sites configured (var.erpnext_site_hostnames is empty) — nothing to back up"
  exit 0
fi

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
OVERALL_STATUS="PASS"
declare -a SITE_REPORTS

for site in $SITE_HOSTNAMES; do
  BACKUP_DIR="sites/${site}/private/backups"
  BEFORE="$(ls -1 "$BACKUP_DIR" 2>/dev/null || true)"

  log "backing up $site"
  if bench --site "$site" backup --with-files; then
    AFTER="$(ls -1 "$BACKUP_DIR" 2>/dev/null || true)"
    # New files this run produced, not the whole directory — bench keeps prior local backups around
    # until this script deletes them below, so a naive `ls` would re-upload every previous run's
    # files too.
    mapfile -t NEW_FILES < <(comm -13 <(echo "$BEFORE" | sort) <(echo "$AFTER" | sort))

    UPLOAD_OK=1
    for f in "${NEW_FILES[@]}"; do
      [ -n "$f" ] || continue
      if ! aws s3 cp "${BACKUP_DIR}/${f}" "s3://${REPORT_BUCKET}/erpnext/${site}/${RUN_ID}/${f}"; then
        UPLOAD_OK=0
      fi
    done

    if [ "$UPLOAD_OK" = "1" ] && [ "${#NEW_FILES[@]}" -gt 0 ]; then
      # EFS cleanup only after every new file is confirmed uploaded — never delete the only copy of
      # a backup that didn't make it to S3.
      for f in "${NEW_FILES[@]}"; do
        [ -n "$f" ] || continue
        rm -f "${BACKUP_DIR}/${f}"
      done
      SITE_STATUS="PASS"
    else
      SITE_STATUS="FAIL"
      OVERALL_STATUS="FAIL"
      log "WARNING: $site backup produced no files or upload failed — left in place on EFS for investigation"
    fi
  else
    SITE_STATUS="FAIL"
    OVERALL_STATUS="FAIL"
    log "WARNING: bench backup failed for $site"
    NEW_FILES=()
  fi

  SITE_REPORTS+=("$(jq -n --arg site "$site" --arg status "$SITE_STATUS" \
    --argjson file_count "${#NEW_FILES[@]}" \
    '{site: $site, status: $status, files_uploaded: $file_count}')")
done

REPORT_FILE="/tmp/erpnext-backup-${RUN_ID}.json"
jq -n --arg run_id "$RUN_ID" --arg status "$OVERALL_STATUS" \
  --argjson sites "[$(IFS=,; echo "${SITE_REPORTS[*]}")]" \
  '{run_id: $run_id, status: $status, sites: $sites}' > "$REPORT_FILE"
aws s3 cp "$REPORT_FILE" "s3://${REPORT_BUCKET}/reports/erpnext/backup/${RUN_ID}.json"

[ "$OVERALL_STATUS" = "PASS" ]
