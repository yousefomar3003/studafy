#!/usr/bin/env bash
# Phase D: deletes the scratch RDS instance restore-scratch.sh created, once
# extract-tenant-slice.sh no longer needs it. A separate, explicit script rather than an automatic
# cleanup trap (unlike ST-265's postgres-restore-verify.sh) because extraction here is a
# human-reviewed process that can legitimately take longer than one script's runtime -- deleting
# the scratch instance the moment extraction finishes would foreclose re-running extraction if the
# operator spots a problem with the first pass.
#
# Usage: teardown-scratch.sh --scratch-db-instance-id <id>
#
# Refuses to run against anything not named like this tool's own scratch instances (restore-
# scratch.sh's default "tenant-restore-<run-id>" prefix), so a typo can't hand this script a real
# instance identifier.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

SCRATCH_ID=""

usage() { echo "Usage: teardown-scratch.sh --scratch-db-instance-id <id>" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --scratch-db-instance-id) SCRATCH_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

[ -n "$SCRATCH_ID" ] || { usage; fail "--scratch-db-instance-id is required"; }
: "${AWS_REGION:?AWS_REGION must be set}"
command -v aws >/dev/null 2>&1 || fail "aws CLI not found on PATH"

case "$SCRATCH_ID" in
  *tenant-restore-*) ;;
  *) fail "$SCRATCH_ID does not look like a tenant-restore scratch instance (expected a \"tenant-restore-\" segment) -- refusing to delete it" ;;
esac

log "deleting $SCRATCH_ID"
aws rds delete-db-instance --db-instance-identifier "$SCRATCH_ID" --skip-final-snapshot --region "$AWS_REGION" >/dev/null \
  || fail "failed to delete $SCRATCH_ID -- it needs manual cleanup"
log "delete requested for $SCRATCH_ID"
