#!/usr/bin/env bash
# Fills the six blank ECS_*/subnet/security-group/target-group lines in
# infra/deploy/environments/<env>.env from `terraform output`, in place. Turns the manual
# "fill these in once the compute-tier module lands" step infra/deploy/README.md's "Known gaps"
# #1-3 used to describe into an actual idempotent script — safe to re-run after every
# `terraform apply` (values change if the compute tier is ever recreated).
#
# Usage:
#   populate-env.sh <dev|staging|prod>
#
# Requires: terraform, jq on PATH; run from a shell already `terraform init -reconfigure
# -backend-config=environments/<env>/backend.hcl`'d against <env>'s backend (see
# infra/terraform/README.md).
set -euo pipefail

ENVIRONMENT="${1:?usage: populate-env.sh <dev|staging|prod>}"

case "$ENVIRONMENT" in
  dev | staging | prod) ;;
  *)
    echo "unknown environment '$ENVIRONMENT' (expected dev, staging, or prod)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
ENV_FILE="$ROOT/infra/deploy/environments/${ENVIRONMENT}.env"

[ -f "$ENV_FILE" ] || {
  echo "no environment file: $ENV_FILE" >&2
  exit 1
}

tf_output() { terraform -chdir="$TF_DIR" output -raw "$1"; }

# infra/deploy/ecs/*/service.json.tpl splices PRIVATE_APP_SUBNET_IDS directly into a JSON array
# ("subnets": [${PRIVATE_APP_SUBNET_IDS}]), so it needs to already be a quoted, comma-joined list
# — not the plain terraform output list shape.
SUBNETS_JSON="$(terraform -chdir="$TF_DIR" output -json private_app_subnet_ids |
  jq -r '[.[] | "\"" + . + "\""] | join(",")')"

declare -A VALUES=(
  [ECS_CLUSTER]="$(tf_output compute_ecs_cluster_name)"
  [ECS_EXECUTION_ROLE_ARN]="$(tf_output compute_ecs_execution_role_arn)"
  [PRIVATE_APP_SUBNET_IDS]="$SUBNETS_JSON"
  [APP_SECURITY_GROUP_ID]="$(tf_output app_security_group_id)"
  [API_TARGET_GROUP_ARN]="$(tf_output compute_api_target_group_arn)"
  [REALTIME_TARGET_GROUP_ARN]="$(tf_output compute_realtime_target_group_arn)"
)

for KEY in "${!VALUES[@]}"; do
  VALUE="${VALUES[$KEY]}"
  # Escape sed's own special replacement characters (/ delimits the s/// command, & means "whole
  # match") — IAM role ARNs contain "/", so this isn't optional.
  ESCAPED="$(printf '%s' "$VALUE" | sed -e 's/[\/&]/\\&/g')"
  sed -i "s/^${KEY}=.*/${KEY}=${ESCAPED}/" "$ENV_FILE"
  echo "  ${KEY}=${VALUE}" >&2
done

echo "populated $ENV_FILE" >&2
