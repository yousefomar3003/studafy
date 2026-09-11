#!/usr/bin/env bash
# Phase A of the tenant-slice restore tool (ST-267): restores a Postgres backup to a scratch RDS
# instance, so extract-tenant-slice.sh has a point-in-time copy to read a school's rows from
# without ever touching the live instance. Same RestoreDBInstanceToPointInTime mechanism ST-265's
# infra/deploy/scripts/postgres-restore-verify.sh already uses -- deliberately not the same
# scratch-instance identifier prefix (this tool uses "-tenant-restore-" where the automated drill
# uses "-pg-verify-"), so the two tools' IAM scoping and blast radius never overlap: see
# infra/terraform/modules/backup/tenant_restore.tf's own scratch-instance ARN pattern.
#
# Unlike the automated weekly drill (which restores, verifies, and deletes in one unattended run),
# this scratch instance is deliberately left running after this script exits -- tenant-slice
# extraction is a human-reviewed, multi-step recovery, not a fire-and-forget check. Run
# teardown-scratch.sh explicitly once extract-tenant-slice.sh has finished with it.
#
# Usage:
#   restore-scratch.sh --source-db-instance-id <id> --db-subnet-group-name <name> \
#     --db-security-group-id <id> [--restore-time <ISO-8601>] [--name-prefix <prefix>]
#
# Requires: aws CLI on PATH, authenticated as the tenant-restore-operator role
# (infra/terraform/modules/backup/tenant_restore.tf's aws_iam_role.tenant_restore_operator).
# AWS_REGION must be set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

SOURCE_DB_INSTANCE_ID=""
DB_SUBNET_GROUP_NAME=""
DB_SECURITY_GROUP_ID=""
RESTORE_TIME=""
NAME_PREFIX="tenant-restore"

usage() {
  cat >&2 <<'EOF'
Usage: restore-scratch.sh --source-db-instance-id <id> --db-subnet-group-name <name>
         --db-security-group-id <id> [--restore-time <ISO-8601>] [--name-prefix <prefix>]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source-db-instance-id) SOURCE_DB_INSTANCE_ID="$2"; shift 2 ;;
    --db-subnet-group-name) DB_SUBNET_GROUP_NAME="$2"; shift 2 ;;
    --db-security-group-id) DB_SECURITY_GROUP_ID="$2"; shift 2 ;;
    --restore-time) RESTORE_TIME="$2"; shift 2 ;;
    --name-prefix) NAME_PREFIX="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

[ -n "$SOURCE_DB_INSTANCE_ID" ] || { usage; fail "--source-db-instance-id is required"; }
[ -n "$DB_SUBNET_GROUP_NAME" ] || { usage; fail "--db-subnet-group-name is required"; }
[ -n "$DB_SECURITY_GROUP_ID" ] || { usage; fail "--db-security-group-id is required"; }
: "${AWS_REGION:?AWS_REGION must be set}"
command -v aws >/dev/null 2>&1 || fail "aws CLI not found on PATH"

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
SCRATCH_ID="${NAME_PREFIX}-${RUN_ID}"

RESTORE_ARGS=(
  --source-db-instance-identifier "$SOURCE_DB_INSTANCE_ID"
  --target-db-instance-identifier "$SCRATCH_ID"
  --db-subnet-group-name "$DB_SUBNET_GROUP_NAME"
  --vpc-security-group-ids "$DB_SECURITY_GROUP_ID"
  --no-multi-az
  --no-publicly-accessible
  --region "$AWS_REGION"
  --tags "Key=Purpose,Value=tenant-restore" "Key=RunId,Value=${RUN_ID}"
)
if [ -n "$RESTORE_TIME" ]; then
  RESTORE_ARGS+=(--restore-time "$RESTORE_TIME")
else
  RESTORE_ARGS+=(--use-latest-restorable-time)
fi

log "restoring $SCRATCH_ID from $SOURCE_DB_INSTANCE_ID (${RESTORE_TIME:-latest restorable time})"
aws rds restore-db-instance-to-point-in-time "${RESTORE_ARGS[@]}" >/dev/null \
  || fail "restore-db-instance-to-point-in-time failed"

log "waiting for $SCRATCH_ID to become available (typically 10-20 minutes)"
aws rds wait db-instance-available --db-instance-identifier "$SCRATCH_ID" --region "$AWS_REGION" \
  || fail "$SCRATCH_ID never became available -- check the RDS console/events before retrying"

SCRATCH_HOST="$(aws rds describe-db-instances --db-instance-identifier "$SCRATCH_ID" --region "$AWS_REGION" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"

log "ready: $SCRATCH_ID at $SCRATCH_HOST"
log "next: PGHOST_OVERRIDE=$SCRATCH_HOST extract-tenant-slice.sh --school-id <uuid> --out-dir <dir>"
log "when done: teardown-scratch.sh --scratch-db-instance-id $SCRATCH_ID"
