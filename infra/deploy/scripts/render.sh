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
ENVIRONMENT="${2:?usage: render.sh <api|realtime|workers> <dev|staging|prod> <template.json.tpl>}"
TEMPLATE="${3:?usage: render.sh <api|realtime|workers> <dev|staging|prod> <template.json.tpl>}"

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
REDIS_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw redis_auth_secret_arn)"
PGBOUNCER_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw pgbouncer_connection_secret_arn)"
PGBOUNCER_HOST="$(terraform -chdir="$TF_DIR" output -raw pgbouncer_private_ip)"
POSTGRES_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw postgres_connection_secret_arn)"
MIGRATIONS_EXECUTION_ROLE_ARN="$(terraform -chdir="$TF_DIR" output -raw compute_migrations_execution_role_arn)"
export REDIS_SECRET_ARN PGBOUNCER_SECRET_ARN PGBOUNCER_HOST POSTGRES_SECRET_ARN MIGRATIONS_EXECUTION_ROLE_ARN

SERVICE_UPPER="$(echo "$SERVICE" | tr '[:lower:]' '[:upper:]')"
export "${SERVICE_UPPER}_IMAGE=${REPO_URL}:${IMAGE_TAG}"
export "${SERVICE_UPPER}_APP_SECRETS_ARN=${SECRET_ARN}"

envsubst < "$TEMPLATE"
