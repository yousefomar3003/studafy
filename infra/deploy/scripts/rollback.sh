#!/usr/bin/env bash
# Rolls an ECS service back to a previous task-definition revision and waits for it to stabilize.
#
# This is the *manual* rollback path — for a deployment that passed health checks but is wrong in
# some way health checks can't see. A deployment that never reaches a healthy steady state at all
# is instead rolled back automatically by deploymentConfiguration.deploymentCircuitBreaker
# (enabled in every service.json in this directory), with no operator action needed.
#
# Usage:
#   rollback.sh <api|realtime|workers> <dev|staging|prod> [target-revision]
#
# target-revision defaults to (current revision - 1). Prints elapsed time so "<5 min" is measured,
# not assumed.
set -euo pipefail

SERVICE="${1:?usage: rollback.sh <api|realtime|workers> <dev|staging|prod> [target-revision]}"
ENVIRONMENT="${2:?usage: rollback.sh <api|realtime|workers> <dev|staging|prod> [target-revision]}"
TARGET_REVISION="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
ENV_FILE="$ROOT/infra/deploy/environments/${ENVIRONMENT}.env"

[ -f "$ENV_FILE" ] || { echo "no environment file: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${ECS_CLUSTER:?ECS_CLUSTER is empty in $ENV_FILE — see README.md Known gaps}"

NAME_PREFIX="$(terraform -chdir="$TF_DIR" output -raw name_prefix)"
FAMILY="${NAME_PREFIX}-${SERVICE}"
SERVICE_NAME="$FAMILY"

CURRENT_TASK_DEF="$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$SERVICE_NAME" \
  --query 'services[0].taskDefinition' --output text)"
CURRENT_REVISION="${CURRENT_TASK_DEF##*:}"

if [ -z "$TARGET_REVISION" ]; then
  TARGET_REVISION=$((CURRENT_REVISION - 1))
fi

if [ "$TARGET_REVISION" -lt 1 ]; then
  echo "no earlier revision to roll back to (current: $FAMILY:$CURRENT_REVISION)" >&2
  exit 1
fi

# Confirms the target revision actually exists (and hasn't been deregistered) before touching the
# live service — a typo'd revision number should fail here, not mid-rollback.
aws ecs describe-task-definition --task-definition "${FAMILY}:${TARGET_REVISION}" >/dev/null

echo "rolling back $SERVICE_NAME: $FAMILY:$CURRENT_REVISION -> $FAMILY:$TARGET_REVISION" >&2
START="$(date +%s)"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$SERVICE_NAME" \
  --task-definition "${FAMILY}:${TARGET_REVISION}" \
  --force-new-deployment >/dev/null

aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$SERVICE_NAME"
END="$(date +%s)"
echo "rollback complete in $((END - START))s"
