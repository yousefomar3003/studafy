#!/usr/bin/env bash
# Verifies and runs the immutable migrations image as a one-off Fargate task. A non-zero task exit
# stops the deployment before any long-running service is updated.
set -euo pipefail

ENVIRONMENT="${1:?usage: migrate.sh <dev|staging|prod> <image-tag-or-digest>}"
export IMAGE_TAG="${2:?usage: migrate.sh <dev|staging|prod> <image-tag-or-digest>}"

case "$ENVIRONMENT" in
  dev | staging | prod) ;;
  *) echo "unknown environment '$ENVIRONMENT'" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
DEPLOY_DIR="$ROOT/infra/deploy"
RENDERED="$(mktemp -d)"
trap 'rm -rf "$RENDERED"' EXIT

REPO_URL="$(terraform -chdir="$TF_DIR" output -json registry_repository_urls | jq -r '.migrations')"
KEY="awskms:///$(terraform -chdir="$TF_DIR" output -raw registry_signing_key_alias)"
IMAGE="${REPO_URL}:${IMAGE_TAG}"

echo "verifying migration image signature: $IMAGE" >&2
cosign verify --key "$KEY" "$IMAGE" >/dev/null

"$DEPLOY_DIR/scripts/render.sh" migrations "$ENVIRONMENT" \
  "$DEPLOY_DIR/ecs/migrations/task-definition.json.tpl" > "$RENDERED/task-definition.json"

TASK_DEFINITION="$(aws ecs register-task-definition \
  --cli-input-json "file://$RENDERED/task-definition.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
CLUSTER="$(terraform -chdir="$TF_DIR" output -raw compute_ecs_cluster_name)"
SUBNETS="$(terraform -chdir="$TF_DIR" output -json private_app_subnet_ids)"
SECURITY_GROUP="$(terraform -chdir="$TF_DIR" output -raw app_security_group_id)"
NETWORK="$(jq -cn --argjson subnets "$SUBNETS" --arg sg "$SECURITY_GROUP" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$sg],assignPublicIp:"DISABLED"}}')"

TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASK_DEFINITION" \
  --network-configuration "$NETWORK" \
  --started-by "studafy-${ENVIRONMENT}-migration" \
  --query 'tasks[0].taskArn' --output text)"

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "ECS did not start the migration task" >&2
  exit 1
fi

echo "waiting for migration task $TASK_ARN" >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[?name==`migrations`].exitCode | [0]' --output text)"
STOPPED_REASON="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)"

if [ "$EXIT_CODE" != "0" ]; then
  echo "migration task failed (exit=$EXIT_CODE): $STOPPED_REASON" >&2
  exit 1
fi
echo "migration task completed successfully" >&2
