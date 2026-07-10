#!/usr/bin/env bash
# Verifies an image's cosign signature, registers a new ECS task-definition revision, and rolls
# the service to it — the "whatever deploys" step docs/runbooks/supply-chain-security.md's
# "Deploy (staging): pull, verify, reject if unsigned" section describes but doesn't itself
# implement, because no compute tier existed yet when that doc was written.
#
# Usage:
#   deploy.sh <api|realtime|workers> <dev|staging|prod> <image-tag-or-digest>
#
# Requires: aws cli, cosign, jq, envsubst (gettext) on PATH; an assumed identity with
# deploy_pull_role_arn's permissions (ecr pull, kms:Verify) plus ecs:RegisterTaskDefinition,
# ecs:UpdateService/CreateService, ecs:DescribeServices, and iam:PassRole on
# ECS_EXECUTION_ROLE_ARN. See README.md's "Known gaps / prerequisites" — this script cannot
# succeed until infra/deploy/environments/<env>.env's ECS_CLUSTER/ECS_EXECUTION_ROLE_ARN/subnet/
# security-group/target-group values are filled in by whatever provisions the compute tier.
set -euo pipefail

SERVICE="${1:?usage: deploy.sh <api|realtime|workers> <dev|staging|prod> <image-tag-or-digest>}"
ENVIRONMENT="${2:?usage: deploy.sh <api|realtime|workers> <dev|staging|prod> <image-tag-or-digest>}"
export IMAGE_TAG="${3:?usage: deploy.sh <api|realtime|workers> <dev|staging|prod> <image-tag-or-digest>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
DEPLOY_DIR="$ROOT/infra/deploy"

RENDERED="$(mktemp -d)"
trap 'rm -rf "$RENDERED"' EXIT

# --- Signature verification, mirroring supply-chain-security.md exactly -----------------------
REPO_URL="$(terraform -chdir="$TF_DIR" output -json registry_repository_urls | jq -r --arg s "$SERVICE" '.[$s]')"
KEY="awskms:///$(terraform -chdir="$TF_DIR" output -raw registry_signing_key_alias)"
IMAGE="${REPO_URL}:${IMAGE_TAG}"

echo "verifying signature: $IMAGE" >&2
if ! cosign verify --key "$KEY" "$IMAGE" >/dev/null; then
  echo "signature verification failed — refusing to deploy $IMAGE" >&2
  exit 1
fi

# --- Register the new task-definition revision --------------------------------------------------
"$DEPLOY_DIR/scripts/render.sh" "$SERVICE" "$ENVIRONMENT" "$DEPLOY_DIR/ecs/$SERVICE/task-definition.json.tpl" \
  > "$RENDERED/task-definition.json"

NEW_TASK_DEF_ARN="$(aws ecs register-task-definition \
  --cli-input-json "file://$RENDERED/task-definition.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
echo "registered $NEW_TASK_DEF_ARN" >&2

# --- Roll the service to it -----------------------------------------------------------------
"$DEPLOY_DIR/scripts/render.sh" "$SERVICE" "$ENVIRONMENT" "$DEPLOY_DIR/ecs/$SERVICE/service.json.tpl" \
  > "$RENDERED/service.json"

CLUSTER="$(jq -r '.cluster' "$RENDERED/service.json")"
SERVICE_NAME="$(jq -r '.serviceName' "$RENDERED/service.json")"

EXISTING="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" \
  --query 'services[?status==`ACTIVE`] | length(@)' --output text 2>/dev/null || echo 0)"

if [ "$EXISTING" != "0" ]; then
  # update-service accepts a narrower field set than create-service — loadBalancers,
  # launchType and schedulingStrategy are create-only and immutable afterward, so they are
  # deliberately not re-sent here rather than fed through --cli-input-json wholesale.
  echo "updating existing service $SERVICE_NAME" >&2
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE_NAME" \
    --task-definition "$NEW_TASK_DEF_ARN" \
    --desired-count "$(jq -r '.desiredCount' "$RENDERED/service.json")" \
    --deployment-configuration "$(jq -c '.deploymentConfiguration' "$RENDERED/service.json")" \
    --force-new-deployment >/dev/null
else
  echo "creating new service $SERVICE_NAME" >&2
  aws ecs create-service --cli-input-json "file://$RENDERED/service.json" >/dev/null
fi

echo "waiting for $SERVICE_NAME to stabilize (this is the rolling deploy)..." >&2
START="$(date +%s)"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE_NAME"
END="$(date +%s)"
echo "$SERVICE_NAME stable after $((END - START))s on $NEW_TASK_DEF_ARN" >&2
