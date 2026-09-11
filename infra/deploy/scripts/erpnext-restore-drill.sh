#!/usr/bin/env bash
# Runs modules/backup's ERPNext restore-drill task on demand — same `aws ecs run-task` shape as
# infra/deploy/scripts/erpnext-new-site.sh and postgres-restore-verify.sh. Use this to re-run the
# monthly drill early, or right after erpnext-new-site.sh creates a school's first backup, instead
# of waiting for the next scheduled run.
#
# Usage: erpnext-restore-drill.sh <staging|prod>
#
# Requires: aws cli on PATH; an identity with ecs:RunTask/DescribeTasks on the restore-drill task
# definition. The ERPNext plane (and this drill) is staging/prod only — see
# infra/terraform/main.tf's local.erpnext_plane_enabled.
set -euo pipefail

ENVIRONMENT="${1:?usage: erpnext-restore-drill.sh <staging|prod>}"

case "$ENVIRONMENT" in
  staging | prod) ;;
  *)
    echo "unknown environment '$ENVIRONMENT' (expected staging or prod — the ERPNext plane is not instantiated in dev, see infra/terraform/main.tf's local.erpnext_plane_enabled)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"

tf_output() { terraform -chdir="$TF_DIR" output -raw "$1"; }

TASK_DEF_ARN="$(tf_output backup_erpnext_restore_drill_task_definition_arn)"
CLUSTER="$(tf_output compute_ecs_cluster_name)"
SECURITY_GROUP="$(tf_output erpnext_security_group_id)"
SUBNETS_JSON="$(terraform -chdir="$TF_DIR" output -json private_app_subnet_ids)"

echo "starting ERPNext restore-drill task in $ENVIRONMENT" >&2
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF_ARN" \
  --launch-type FARGATE \
  --network-configuration "{\"awsvpcConfiguration\":{\"subnets\":${SUBNETS_JSON},\"securityGroups\":[\"${SECURITY_GROUP}\"],\"assignPublicIp\":\"DISABLED\"}}" \
  --query 'tasks[0].taskArn' --output text)"

echo "waiting for restore-drill task to finish: $TASK_ARN" >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"

if [ "$EXIT_CODE" != "0" ]; then
  echo "restore-drill FAILED (exit $EXIT_CODE) — check /${ENVIRONMENT}/ecs/backup-erpnext-restore-drill in CloudWatch Logs" >&2
  exit 1
fi

echo "restore-drill PASSED" >&2
