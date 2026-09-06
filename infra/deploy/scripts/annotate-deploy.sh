#!/usr/bin/env bash
# Writes one structured line to modules/monitoring's deploy log group
# (/<name_prefix>/deploys), rendered by the operations dashboard's "Recent deploys" widget
# (infra/terraform/modules/monitoring/main.tf). This is the staging deploy pipeline's "deploy
# annotations appear in monitoring" acceptance criterion — a CloudWatch Logs Insights table, not a
# metric-graph marker, since CloudWatch has no API to drop a discrete timestamped annotation on a
# live metric widget outside a fixed dashboard revision (see that module's README).
#
# Usage:
#   annotate-deploy.sh <environment> <status> <run-url>
#
# status is a free-form label (e.g. migration_failed, deploy_failed, smoke_failed_rolled_back,
# succeeded) — this script does not validate it against a fixed set, so the pipeline's own job
# names stay the single source of truth for what statuses exist.
#
# Requires: aws cli, jq. Reads IMAGE_TAG, SERVICES, ACTOR from the environment (all optional —
# omitted fields simply render empty in the dashboard table).
set -euo pipefail

ENVIRONMENT="${1:?usage: annotate-deploy.sh <environment> <status> <run-url>}"
STATUS="${2:?usage: annotate-deploy.sh <environment> <status> <run-url>}"
RUN_URL="${3:?usage: annotate-deploy.sh <environment> <status> <run-url>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"

LOG_GROUP="$(terraform -chdir="$TF_DIR" output -raw monitoring_deploys_log_group_name)"
LOG_STREAM="$(date -u +%Y-%m-%d)"
TIMESTAMP_MS="$(($(date +%s%N) / 1000000))"
REQUEST="$(mktemp)"
trap 'rm -f "$REQUEST"' EXIT

aws logs create-log-stream --log-group-name "$LOG_GROUP" --log-stream-name "$LOG_STREAM" 2>/dev/null || true

# --cli-input-json, not --log-events shorthand: shorthand splits on "," and the message is a JSON
# object full of them (same reasoning migrate.sh's --cli-input-json use documents).
jq -nc \
  --arg group "$LOG_GROUP" \
  --arg stream "$LOG_STREAM" \
  --argjson timestamp "$TIMESTAMP_MS" \
  --arg environment "$ENVIRONMENT" \
  --arg service "${SERVICES:-}" \
  --arg imageTag "${IMAGE_TAG:-}" \
  --arg status "$STATUS" \
  --arg actor "${ACTOR:-}" \
  --arg runUrl "$RUN_URL" \
  '{
    logGroupName: $group,
    logStreamName: $stream,
    logEvents: [{
      timestamp: $timestamp,
      message: ({environment: $environment, service: $service, imageTag: $imageTag, status: $status, actor: $actor, runUrl: $runUrl} | tojson)
    }]
  }' > "$REQUEST"

aws logs put-log-events --cli-input-json "file://$REQUEST" >/dev/null

echo "annotated $ENVIRONMENT deploy: $STATUS" >&2
