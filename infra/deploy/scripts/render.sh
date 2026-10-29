#!/usr/bin/env bash
# Renders one ECS task-definition or service JSON template for a given service + environment,
# substituting ${VAR} placeholders with values from infra/terraform's outputs (dynamic — subnets,
# ARNs, name_prefix) and infra/deploy/environments/<env>.env (static — replica counts, cpu/memory,
# rolling-update thresholds). Writes the rendered JSON to stdout.
#
# Usage:
#   render.sh <api|realtime|workers|migrations> <dev|staging|prod> <path-to-template.json.tpl>
#
# IMAGE_TAG must be exported by the caller (deploy.sh does this) — it is the one value neither
# terraform output nor environments/<env>.env can supply, since it names a specific build.
set -euo pipefail

SERVICE="${1:?usage: render.sh <api|realtime|workers|migrations> <dev|staging|prod> <template.json.tpl>}"
ENVIRONMENT="${2:?usage: render.sh <api|realtime|workers|migrations> <dev|staging|prod> <template.json.tpl>}"
TEMPLATE="${3:?usage: render.sh <api|realtime|workers|migrations> <dev|staging|prod> <template.json.tpl>}"

case "$SERVICE" in
  api | realtime | workers | migrations) ;;
  *)
    echo "unknown service '$SERVICE' (expected api, realtime, workers, or migrations)" >&2
    exit 1
    ;;
esac

case "$ENVIRONMENT" in
  dev | staging | prod) ;;
  *)
    echo "unknown environment '$ENVIRONMENT' (expected dev, staging, or prod)" >&2
    exit 1
    ;;
esac

: "${IMAGE_TAG:?IMAGE_TAG must be exported — the image tag or digest to render into the task definition}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
ENV_FILE="$ROOT/infra/deploy/environments/${ENVIRONMENT}.env"

[ -f "$ENV_FILE" ] || { echo "no environment file: $ENV_FILE" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "no template file: $TEMPLATE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Dynamic values — always read live from terraform output, never duplicated into environments/*.env,
# so this script can't drift from what's actually applied (same reasoning docs/runbooks/
# supply-chain-security.md and cdn-cache-policy.md already use `terraform -chdir=... output` for).
export NAME_PREFIX AWS_REGION
NAME_PREFIX="$(terraform -chdir="$TF_DIR" output -raw name_prefix)"
AWS_REGION="$(terraform -chdir="$TF_DIR" output -raw aws_region)"

REPO_URL="$(terraform -chdir="$TF_DIR" output -json registry_repository_urls | jq -r --arg s "$SERVICE" '.[$s]')"
if [ "$REPO_URL" = "null" ] || [ -z "$REPO_URL" ]; then
  echo "no ECR repository for '$SERVICE' in registry_repository_urls" >&2
  exit 1
fi

SECRET_ARN="$(terraform -chdir="$TF_DIR" output -json secrets_service_secret_arns | jq -r --arg s "$SERVICE" '.[$s] // empty')"
# ST-259: Cloud Map discovery-service ARN this service's own serviceRegistries entry registers
# into, so Prometheus can find it (module.monitoring's discovery.tf). Empty for migrations, which
# has no service.json.tpl/serviceRegistries entry at all — jq's // empty makes that a non-error.
METRICS_SD_ARN="$(terraform -chdir="$TF_DIR" output -json monitoring_metrics_discovery_service_arns | jq -r --arg s "$SERVICE" '.[$s] // empty')"
REDIS_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw redis_auth_secret_arn)"
PGBOUNCER_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw pgbouncer_connection_secret_arn)"
PGBOUNCER_HOST="$(terraform -chdir="$TF_DIR" output -raw pgbouncer_private_ip)"
POSTGRES_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw postgres_connection_secret_arn)"
MIGRATIONS_EXECUTION_ROLE_ARN="$(terraform -chdir="$TF_DIR" output -raw compute_migrations_execution_role_arn)"
API_TASK_ROLE_ARN="$(terraform -chdir="$TF_DIR" output -raw compute_api_task_role_arn)"
WORKERS_TASK_ROLE_ARN="$(terraform -chdir="$TF_DIR" output -raw compute_workers_task_role_arn)"
S3_APP_FILES_BUCKET="$(terraform -chdir="$TF_DIR" output -raw storage_app_files_bucket_id)"
STORAGE_SENSITIVE_KMS_KEY_ID="$(terraform -chdir="$TF_DIR" output -raw storage_sensitive_documents_kms_key_arn)"
export REDIS_SECRET_ARN PGBOUNCER_SECRET_ARN PGBOUNCER_HOST POSTGRES_SECRET_ARN
export MIGRATIONS_EXECUTION_ROLE_ARN API_TASK_ROLE_ARN WORKERS_TASK_ROLE_ARN S3_APP_FILES_BUCKET
export STORAGE_SENSITIVE_KMS_KEY_ID

# The ERPNext plane's internal ALB (staging/prod only; null in dev, which leaves the integration off --
# an empty ERPNEXT_API_URL counts as unset). apps/api and the workers call it over plain HTTP inside the
# VPC with the Host header picking each school's site (modules/erpnext/README.md).
ERPNEXT_ALB_DNS="$(terraform -chdir="$TF_DIR" output -json erpnext_internal_alb_dns_name | jq -r '. // empty')"
export ERPNEXT_API_URL="${ERPNEXT_ALB_DNS:+http://$ERPNEXT_ALB_DNS}"

# Transactional email (modules/email): the SES configuration set the workers send through, and the
# bounce/complaint topic the API's /email/webhooks/sns verifies messages against. Both null (empty
# here) where the tier has no sending domain -- that tier sets EMAIL_DRY_RUN=true.
export SES_CONFIGURATION_SET="$(terraform -chdir="$TF_DIR" output -json email_configuration_set_name | jq -r '. // empty')"
export EMAIL_EVENTS_SNS_TOPIC_ARN="$(terraform -chdir="$TF_DIR" output -json email_events_topic_arn | jq -r '. // empty')"

SERVICE_UPPER="$(echo "$SERVICE" | tr '[:lower:]' '[:upper:]')"
export "${SERVICE_UPPER}_IMAGE=${REPO_URL}:${IMAGE_TAG}"
export "${SERVICE_UPPER}_APP_SECRETS_ARN=${SECRET_ARN}"
export "${SERVICE_UPPER}_METRICS_SD_ARN=${METRICS_SD_ARN}"

# The workers task runs a ClamAV sidecar (infra/docker/clamav.Dockerfile) — release.yml builds and
# pushes it under the same tag as every other image in the release, so it is rendered alongside the
# workers image rather than pinned separately.
if [ "$SERVICE" = "workers" ]; then
  CLAMAV_REPO_URL="$(terraform -chdir="$TF_DIR" output -json registry_repository_urls | jq -r '.clamav')"
  if [ "$CLAMAV_REPO_URL" = "null" ] || [ -z "$CLAMAV_REPO_URL" ]; then
    echo "no ECR repository for 'clamav' in registry_repository_urls (needed by the workers sidecar)" >&2
    exit 1
  fi
  export CLAMAV_IMAGE="${CLAMAV_REPO_URL}:${IMAGE_TAG}"
fi

envsubst < "$TEMPLATE"
