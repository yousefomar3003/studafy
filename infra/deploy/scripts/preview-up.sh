#!/usr/bin/env bash
# Brings one PR's preview environment up: render + register the two-container task definition, run
# it as a single FARGATE task with a public IP, point pr-<n>.<preview-domain> at that IP, and wait
# until the preview answers /healthz. Idempotent — a re-run (a new push to the PR) registers a new
# task-definition revision, starts a fresh task, and UPSERTs the same DNS record; preview-down.sh
# is expected to have stopped the previous task via concurrency cancellation, but a leftover is
# also swept by TTL (see pr-preview-teardown.yml).
#
# Usage:
#   preview-up.sh <pr-number> <api-image> <web-image> <image-tag>
#
# Requires: aws cli, jq, envsubst (gettext), curl on PATH; an assumed identity that can
# ecs:RegisterTaskDefinition / RunTask / DescribeTasks, ec2:DescribeNetworkInterfaces, and
# route53:ChangeResourceRecordSets on PREVIEW_DNS_ZONE_ID. Reads infra/deploy/environments/preview.env.
#
# On success, prints `key=value` lines (preview_url, preview_host, task_arn, task_def_arn) to
# stdout and, when running in GitHub Actions, appends them to $GITHUB_OUTPUT.
set -euo pipefail

PR_NUMBER="${1:?usage: preview-up.sh <pr-number> <api-image> <web-image> <image-tag>}"
API_IMAGE="${2:?usage: preview-up.sh <pr-number> <api-image> <web-image> <image-tag>}"
WEB_IMAGE="${3:?usage: preview-up.sh <pr-number> <api-image> <web-image> <image-tag>}"
IMAGE_TAG="${4:?usage: preview-up.sh <pr-number> <api-image> <web-image> <image-tag>}"

case "$PR_NUMBER" in
  '' | *[!0-9]*) echo "pr-number must be a positive integer, got '$PR_NUMBER'" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$ROOT/infra/deploy/environments/preview.env"
TEMPLATE="$ROOT/infra/deploy/preview/task-definition.json.tpl"

[ -f "$ENV_FILE" ] || { echo "no environment file: $ENV_FILE" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "no template file: $TEMPLATE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for var in PREVIEW_ECS_CLUSTER PREVIEW_EXECUTION_ROLE_ARN PREVIEW_SUBNET_ID \
           PREVIEW_SECURITY_GROUP_ID PREVIEW_DNS_ZONE_ID PREVIEW_BASE_DOMAIN \
           PREVIEW_DB_HOST PREVIEW_DB_PORT PREVIEW_DB_SECRET_ARN PREVIEW_CPU PREVIEW_MEMORY; do
  [ -n "${!var:-}" ] || { echo "$var is empty in $ENV_FILE — the preview layer is not provisioned yet" >&2; exit 1; }
done

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-central-1}}"
STARTED_BY="studafy-preview-pr-${PR_NUMBER}"
PREVIEW_HOST="pr-${PR_NUMBER}.${PREVIEW_BASE_DOMAIN}"
PREVIEW_URL="http://${PREVIEW_HOST}:8080"

# --- Stop any task from a previous deploy of this PR --------------------------------------------
# A new push cancels the in-flight workflow (concurrency: cancel-in-progress), which can leave its
# task running. Stop those first so a PR never has more than one live preview task; DNS and the
# database are handled below / by the database job, not here.
mapfile -t PRIOR < <(aws ecs list-tasks --cluster "$PREVIEW_ECS_CLUSTER" --started-by "$STARTED_BY" \
  --desired-status RUNNING --query 'taskArns[]' --output text | tr '\t' '\n' | sed '/^$/d')
for task in "${PRIOR[@]:-}"; do
  [ -n "$task" ] || continue
  echo "stopping prior preview task $task" >&2
  aws ecs stop-task --cluster "$PREVIEW_ECS_CLUSTER" --task "$task" \
    --reason "superseded by a newer preview build (PR #${PR_NUMBER})" --output text >/dev/null || true
done

# --- Render + register the task definition --------------------------------------------------------
export PREVIEW_FAMILY="studafy-preview-pr-${PR_NUMBER}"
export PREVIEW_API_IMAGE="$API_IMAGE"
export PREVIEW_WEB_IMAGE="$WEB_IMAGE"
export PREVIEW_IMAGE_TAG="$IMAGE_TAG"
export PREVIEW_DB_NAME="preview_pr_${PR_NUMBER}"
export PREVIEW_LOG_GROUP="/studafy-preview/ecs/pr-${PR_NUMBER}"
export AWS_REGION

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
# Restricted variable list: the healthcheck commands in the template contain their own $-syntax
# that envsubst must not touch.
envsubst '${PREVIEW_FAMILY} ${PREVIEW_CPU} ${PREVIEW_MEMORY} ${PREVIEW_EXECUTION_ROLE_ARN}
          ${PREVIEW_API_IMAGE} ${PREVIEW_WEB_IMAGE} ${PREVIEW_IMAGE_TAG}
          ${PREVIEW_DB_HOST} ${PREVIEW_DB_PORT} ${PREVIEW_DB_NAME} ${PREVIEW_DB_SECRET_ARN}
          ${PREVIEW_LOG_GROUP} ${AWS_REGION}' < "$TEMPLATE" > "$RENDERED"

jq empty "$RENDERED" || { echo "rendered task definition is not valid JSON" >&2; exit 1; }

TASK_DEF_ARN="$(aws ecs register-task-definition \
  --cli-input-json "file://$RENDERED" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
echo "registered $TASK_DEF_ARN" >&2

# --- Run the task ------------------------------------------------------------------------------------
NETWORK="$(jq -cn --arg sub "$PREVIEW_SUBNET_ID" --arg sg "$PREVIEW_SECURITY_GROUP_ID" \
  '{awsvpcConfiguration:{subnets:[$sub],securityGroups:[$sg],assignPublicIp:"ENABLED"}}')"

TASK_ARN="$(aws ecs run-task \
  --cluster "$PREVIEW_ECS_CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASK_DEF_ARN" \
  --network-configuration "$NETWORK" \
  --started-by "$STARTED_BY" \
  --tags "key=studafy:preview-pr,value=${PR_NUMBER}" "key=studafy:preview-image-tag,value=${IMAGE_TAG}" \
  --query 'tasks[0].taskArn' --output text)"

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "ECS did not start a preview task" >&2
  exit 1
fi
echo "started $TASK_ARN" >&2

echo "waiting for the task to reach RUNNING..." >&2
aws ecs wait tasks-running --cluster "$PREVIEW_ECS_CLUSTER" --tasks "$TASK_ARN"

# --- Resolve the public IP and publish DNS --------------------------------------------------------
ENI_ID="$(aws ecs describe-tasks --cluster "$PREVIEW_ECS_CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" --output text)"
PUBLIC_IP="$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI_ID" \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)"

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" = "None" ]; then
  echo "preview task has no public IP — check PREVIEW_SUBNET_ID is a public subnet" >&2
  exit 1
fi
echo "task public IP: $PUBLIC_IP" >&2

CHANGE_ID="$(aws route53 change-resource-record-sets --hosted-zone-id "$PREVIEW_DNS_ZONE_ID" \
  --change-batch "$(jq -cn --arg name "$PREVIEW_HOST" --arg ip "$PUBLIC_IP" '{
    Comment: "studafy pr preview",
    Changes: [{
      Action: "UPSERT",
      ResourceRecordSet: { Name: $name, Type: "A", TTL: 60, ResourceRecords: [{ Value: $ip }] }
    }]
  }')" --query 'ChangeInfo.Id' --output text)"
aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
echo "DNS: $PREVIEW_HOST -> $PUBLIC_IP" >&2

# --- Wait for the preview to actually answer ------------------------------------------------------
# Hit the IP with a Host header rather than the hostname, so a slow DNS propagation to this runner
# does not look like a dead preview. Both containers must be up: /healthz is nginx, /api/healthz
# proxies through to the api container.
ready=0
for attempt in $(seq 1 40); do
  web_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "${PREVIEW_HOST}:8080:${PUBLIC_IP}" "http://${PREVIEW_HOST}:8080/healthz" || echo 000)"
  api_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "${PREVIEW_HOST}:8080:${PUBLIC_IP}" "http://${PREVIEW_HOST}:8080/api/healthz" || echo 000)"
  if [ "$web_code" = "200" ] && [ "$api_code" = "200" ]; then
    ready=1
    echo "preview healthy after ${attempt} attempt(s)" >&2
    break
  fi
  echo "attempt ${attempt}: web=$web_code api=$api_code" >&2
  sleep 6
done
[ "$ready" = "1" ] || { echo "preview did not become healthy within ~4 minutes" >&2; exit 1; }

emit() {
  echo "$1"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT"
}
emit "preview_url=${PREVIEW_URL}"
emit "preview_host=${PREVIEW_HOST}"
emit "task_arn=${TASK_ARN}"
emit "task_def_arn=${TASK_DEF_ARN}"
