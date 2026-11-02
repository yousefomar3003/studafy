#!/usr/bin/env bash
# Tears one PR's preview environment down and VERIFIES nothing is left running or billable:
#   1. stop every preview task started for this PR, wait until they are STOPPED
#   2. delete the pr-<n>.<preview-domain> DNS record
#   3. drop the preview_pr_<n> database   (only if PREVIEW_DATABASE_ADMIN_URL is set)
#   4. deregister the studafy-preview-pr-<n> task-definition revisions   (tidy-up, best effort)
#   5. re-check 1–3 and exit non-zero if any residue remains
#
# Safe to run repeatedly and safe to run against a PR that never had a preview — every step is
# "remove if present". Called by pr-preview-teardown.yml on `pull_request: closed` and by its
# scheduled TTL sweep.
#
# Usage:
#   preview-down.sh <pr-number>
#
# Requires: aws cli, jq on PATH (psql too, if PREVIEW_DATABASE_ADMIN_URL is set). Reads
# infra/deploy/environments/preview.env.
set -euo pipefail

PR_NUMBER="${1:?usage: preview-down.sh <pr-number>}"
case "$PR_NUMBER" in
  '' | *[!0-9]*) echo "pr-number must be a positive integer, got '$PR_NUMBER'" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$ROOT/infra/deploy/environments/preview.env"
[ -f "$ENV_FILE" ] || { echo "no environment file: $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for var in PREVIEW_ECS_CLUSTER PREVIEW_DNS_ZONE_ID PREVIEW_BASE_DOMAIN; do
  [ -n "${!var:-}" ] || { echo "$var is empty in $ENV_FILE — the preview layer is not provisioned yet" >&2; exit 1; }
done

STARTED_BY="studafy-preview-pr-${PR_NUMBER}"
PREVIEW_HOST="pr-${PR_NUMBER}.${PREVIEW_BASE_DOMAIN}"
FAMILY="studafy-preview-pr-${PR_NUMBER}"

# --- 1. Stop tasks --------------------------------------------------------------------------------
mapfile -t TASKS < <(aws ecs list-tasks --cluster "$PREVIEW_ECS_CLUSTER" \
  --started-by "$STARTED_BY" --desired-status RUNNING --query 'taskArns[]' --output text | tr '\t' '\n' | sed '/^$/d')

if [ "${#TASKS[@]}" -gt 0 ]; then
  echo "stopping ${#TASKS[@]} task(s) for PR #${PR_NUMBER}" >&2
  for task in "${TASKS[@]}"; do
    aws ecs stop-task --cluster "$PREVIEW_ECS_CLUSTER" --task "$task" \
      --reason "pr-preview teardown (PR #${PR_NUMBER})" --query 'task.taskArn' --output text >&2
  done
  aws ecs wait tasks-stopped --cluster "$PREVIEW_ECS_CLUSTER" --tasks "${TASKS[@]}"
else
  echo "no running tasks for PR #${PR_NUMBER}" >&2
fi

# --- 2. Delete DNS -------------------------------------------------------------------------------
RRSET="$(aws route53 list-resource-record-sets --hosted-zone-id "$PREVIEW_DNS_ZONE_ID" \
  --start-record-name "${PREVIEW_HOST}." --start-record-type A --max-items 1 \
  --query "ResourceRecordSets[?Name=='${PREVIEW_HOST}.' && Type=='A'] | [0]" --output json)"

if [ "$RRSET" != "null" ] && [ -n "$RRSET" ]; then
  echo "deleting DNS record ${PREVIEW_HOST}" >&2
  aws route53 change-resource-record-sets --hosted-zone-id "$PREVIEW_DNS_ZONE_ID" \
    --change-batch "$(jq -cn --argjson rr "$RRSET" '{Comment:"studafy pr preview teardown",Changes:[{Action:"DELETE",ResourceRecordSet:$rr}]}')" \
    --query 'ChangeInfo.Id' --output text >&2
else
  echo "no DNS record for ${PREVIEW_HOST}" >&2
fi

# --- 3. Drop the database ----------------------------------------------------------------------------
if [ -n "${PREVIEW_DATABASE_ADMIN_URL:-}" ]; then
  "$SCRIPT_DIR/preview-db.sh" drop "$PR_NUMBER"
else
  echo "PREVIEW_DATABASE_ADMIN_URL not set — skipping database drop (teardown verification below will not check it)" >&2
fi

# --- 4. Deregister task definitions (best effort) ----------------------------------------------------
mapfile -t TASKDEFS < <(aws ecs list-task-definitions --family-prefix "$FAMILY" --status ACTIVE \
  --query 'taskDefinitionArns[]' --output text | tr '\t' '\n' | sed '/^$/d')
if [ "${#TASKDEFS[@]}" -gt 0 ]; then
  for td in "${TASKDEFS[@]}"; do
    aws ecs deregister-task-definition --task-definition "$td" \
      --query 'taskDefinition.taskDefinitionArn' --output text >&2 || true
  done
fi

# --- 5. Verify --------------------------------------------------------------------------------------
residue=0

still_running="$(aws ecs list-tasks --cluster "$PREVIEW_ECS_CLUSTER" --started-by "$STARTED_BY" \
  --desired-status RUNNING --query 'length(taskArns)' --output text)"
if [ "$still_running" != "0" ]; then
  echo "::error::${still_running} preview task(s) still running for PR #${PR_NUMBER}" >&2
  residue=1
fi

dns_left="$(aws route53 list-resource-record-sets --hosted-zone-id "$PREVIEW_DNS_ZONE_ID" \
  --start-record-name "${PREVIEW_HOST}." --start-record-type A --max-items 1 \
  --query "length(ResourceRecordSets[?Name=='${PREVIEW_HOST}.' && Type=='A'])" --output text)"
if [ "$dns_left" != "0" ]; then
  echo "::error::DNS record ${PREVIEW_HOST} still present" >&2
  residue=1
fi

if [ -n "${PREVIEW_DATABASE_ADMIN_URL:-}" ]; then
  if "$SCRIPT_DIR/preview-db.sh" exists "$PR_NUMBER"; then
    echo "::error::database preview_pr_${PR_NUMBER} still present" >&2
    residue=1
  fi
fi

if [ "$residue" -ne 0 ]; then
  echo "teardown INCOMPLETE for PR #${PR_NUMBER}" >&2
  exit 1
fi
echo "teardown verified for PR #${PR_NUMBER}: no tasks, no DNS record, no database" >&2
