#!/usr/bin/env bash
# Runs modules/backup's Postgres restore-verify task on demand via `aws ecs run-task` — the same
# invocation shape as infra/deploy/scripts/erpnext-new-site.sh. Two uses:
#   - staging/prod: re-run the weekly drill early, or re-run a failed one, without waiting for the
#     EventBridge schedule.
#   - dev: demonstrate PITR to an arbitrary timestamp (the acceptance criterion the recurring
#     schedule doesn't exercise, since it always uses --use-latest-restorable-time) via
#     --restore-time.
#
# Usage:
#   postgres-restore-verify.sh <dev|staging|prod> [--restore-time=2026-09-01T03:15:00Z]
#
# Requires: aws cli, jq on PATH; an identity with ecs:RunTask/DescribeTasks on the restore-verify
# task definition (the same ecs:RunTask/iam:PassRole shape modules/backup grants its own
# EventBridge Scheduler role, granted here to whatever identity runs this script instead).
set -euo pipefail

ENVIRONMENT="${1:?usage: postgres-restore-verify.sh <dev|staging|prod> [--restore-time=<ISO-8601>]}"
RESTORE_TIME_ARG="${2:-}"
RESTORE_TIME=""
if [[ "$RESTORE_TIME_ARG" == --restore-time=* ]]; then
  RESTORE_TIME="${RESTORE_TIME_ARG#--restore-time=}"
fi

case "$ENVIRONMENT" in
  dev | staging | prod) ;;
  *)
    echo "unknown environment '$ENVIRONMENT' (expected dev, staging or prod)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"

tf_output() { terraform -chdir="$TF_DIR" output -raw "$1"; }

TASK_DEF_ARN="$(tf_output backup_postgres_restore_verify_task_definition_arn)"
CLUSTER="$(tf_output compute_ecs_cluster_name)"
SUBNETS_JSON="$(terraform -chdir="$TF_DIR" output -json private_app_subnet_ids)"
BACKUP_SG="$(tf_output backup_security_group_id)"

OVERRIDE_JSON='{"containerOverrides":[{"name":"restore-verify","environment":[]}]}'
if [ -n "$RESTORE_TIME" ]; then
  echo "demonstrating PITR to $RESTORE_TIME (not the latest restorable time)" >&2
  OVERRIDE_JSON="$(jq -n --arg t "$RESTORE_TIME" '{containerOverrides:[{name:"restore-verify",environment:[{name:"RESTORE_TIME",value:$t}]}]}')"
fi

echo "starting Postgres restore-verify task in $ENVIRONMENT" >&2
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF_ARN" \
  --launch-type FARGATE \
  --network-configuration "{\"awsvpcConfiguration\":{\"subnets\":${SUBNETS_JSON},\"securityGroups\":[\"${BACKUP_SG}\"],\"assignPublicIp\":\"DISABLED\"}}" \
  --overrides "$OVERRIDE_JSON" \
  --query 'tasks[0].taskArn' --output text)"

echo "waiting for restore-verify task to finish (a real restore typically takes 10-20 minutes): $TASK_ARN" >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"

if [ "$EXIT_CODE" != "0" ]; then
  echo "restore-verify FAILED (exit $EXIT_CODE) — check /${ENVIRONMENT}/ecs/backup-postgres-restore-verify in CloudWatch Logs, and the report under s3://\$(terraform -chdir=$TF_DIR output -raw storage_backups_archive_bucket_id)/reports/postgres/restore-verify/" >&2
  exit 1
fi

echo "restore-verify PASSED" >&2
