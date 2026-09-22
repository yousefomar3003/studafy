#!/usr/bin/env bash
# Rotates one application secret inside a service's app-secrets Secrets Manager container
# (${name_prefix}/<service>/app-secrets), then rolls the service so running tasks pick the new
# value up. This is the mechanical half of the provider-key/webhook/app-secret rotations in
# docs/runbooks/security/; acquiring the new value (provider console, generator) stays manual and
# is that runbook's job.
#
# It deliberately goes THROUGH Terraform rather than calling `aws secretsmanager put-secret-value`
# out of band: modules/secrets declares no lifecycle.ignore_changes on its app-secret versions and
# Terraform is the stated source of truth (docs/runbooks/secrets-conventions.md), so an out-of-band
# write would be silently reverted on the next apply. The script re-reads every service's current
# secret value from AWS, merges the one new key, and exports the whole map as
# TF_VAR_secrets_app_secret_values — dropping another service's existing value here would be a
# latent secret-revert, not a tidy rotation.
#
# The secret that is rotated in a plain `terraform apply` (no TF_VAR override) can revert to its
# authored default (e.g. realtime's WS_JWT_SECRET defaults to a terraform random_password in the
# root module). This script always supplies the override, so its own rotations are stable; an
# operator applying without the override reintroduces that convention, not a bug here.
#
# Usage:
#   rotate-app-secret.sh <dev|staging|prod> <api|realtime|workers> <KEY> <--generate|value>
#
#   <value> is used verbatim. --generate produces a 64-hex-char value via `openssl rand -hex 32`
#   (for symmetric secrets with no provider-side lifecycle); provider-issued keys are passed as a
#   value instead.
#
# Requires: aws cli, jq, terraform (initialized for the environment's backend with the same
# TF_VAR_bastion_allowed_ssh_cidrs/TF_VAR_bastion_key_name exports any apply needs), and an identity
# with secretsmanager:GetSecretValue on every service's app-secrets ARN, plus
# ecs:UpdateService/DescribeServices on the target service. Set CI=true or TF_IN_AUTOMATION=1 to
# apply non-interactively.
set -euo pipefail

ENVIRONMENT="${1:?usage: rotate-app-secret.sh <dev|staging|prod> <api|realtime|workers> <KEY> <--generate|value>}"
SERVICE="${2:?usage: rotate-app-secret.sh <dev|staging|prod> <api|realtime|workers> <KEY> <--generate|value>}"
KEY="${3:?usage: rotate-app-secret.sh <dev|staging|prod> <api|realtime|workers> <KEY> <--generate|value>}"
MODE="${4:?usage: rotate-app-secret.sh <dev|staging|prod> <api|realtime|workers> <KEY> <--generate|value>}"

case "$ENVIRONMENT" in dev | staging | prod) ;; *) echo "unknown environment '$ENVIRONMENT'" >&2; exit 1 ;; esac
case "$SERVICE" in api | realtime | workers) ;; *) echo "unknown service '$SERVICE' (expected api, realtime, or workers)" >&2; exit 1 ;; esac
case "$KEY" in
  [A-Za-z_][A-Za-z0-9_]*) ;;
  *) echo "invalid secret KEY '$KEY' (expected an env-var-shaped name)" >&2; exit 1 ;;
esac

if [ "$MODE" = "--generate" ]; then
  VALUE="$(openssl rand -hex 32)"
elif [ -n "$MODE" ]; then
  VALUE="$MODE"
else
  echo "usage: pass <value> or --generate (got empty fourth argument)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
TFVARS="environments/$ENVIRONMENT/$ENVIRONMENT.tfvars"
[ -f "$TF_DIR/$TFVARS" ] || { echo "no tfvars file: $TF_DIR/$TFVARS" >&2; exit 1; }

NAME_PREFIX="$(terraform -chdir="$TF_DIR" output -raw name_prefix)"
SERVICES_JSON="$(terraform -chdir="$TF_DIR" output -json secrets_service_secret_arns)"
SECRET_ARN="$(echo "$SERVICES_JSON" | jq -r --arg s "$SERVICE" '.[$s] // empty')"
if [ -z "$SECRET_ARN" ]; then
  echo "no app-secrets ARN for '$SERVICE' in secrets_service_secret_arns" >&2
  exit 1
fi

# --- Rebuild the full TF_VAR map from the current live values (see header) --------------------
# Each service's secret holds its own JSON object; the root module's app_secret_values is a
# per-service map of those objects, so the per-service ARN JSON maps onto it 1:1.
TF_VAR_JSON="{}"
while read -r svc; do
  [ -z "$svc" ] && continue
  arn="$(echo "$SERVICES_JSON" | jq -r --arg s "$svc" '.[$s] // empty')"
  [ -z "$arn" ] && continue
  current="$(aws secretsmanager get-secret-value --secret-id "$arn" --query SecretString --output text)"
  if [ "$svc" = "$SERVICE" ]; then
    current="$(echo "$current" | jq --arg k "$KEY" --arg v "$VALUE" '.[$k] = $v')"
  fi
  TF_VAR_JSON="$(echo "$TF_VAR_JSON" | jq --arg s "$svc" --argjson o "$current" '.[$s] = $o')"
done <<< "$(echo "$SERVICES_JSON" | jq -r 'keys[]')"

export TF_VAR_secrets_app_secret_values="$TF_VAR_JSON"

# --- Apply only this secret version -----------------------------------------------------------
TARGET="module.secrets.aws_secretsmanager_secret_version.app[\"$SERVICE\"]"
echo "applying $TARGET ($KEY) in $ENVIRONMENT..." >&2
if [ "${CI:-}" = "true" ] || [ "${TF_IN_AUTOMATION:-}" = "1" ]; then
  terraform -chdir="$TF_DIR" apply -auto-approve -var-file="$TFVARS" -target="$TARGET"
else
  terraform -chdir="$TF_DIR" apply -var-file="$TFVARS" -target="$TARGET"
fi

# --- Roll the service so new tasks read the new value at launch -------------------------------
CLUSTER="$(terraform -chdir="$TF_DIR" output -raw compute_ecs_cluster_name)"
SERVICE_NAME="$NAME_PREFIX-$SERVICE"
echo "forcing a rolling deployment of $SERVICE_NAME (EC2 tasks re-read secrets at launch)..." >&2
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE_NAME" --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE_NAME"
echo "service $SERVICE_NAME is stable." >&2

# --- Verification pointers (not a substitute for the runbook's per-provider checks) -----------
CHECKED_IN="$(echo "$TF_VAR_JSON" | jq -r --arg s "$SERVICE" --arg k "$KEY" '.[$s] | .[$k]')"
if [ "$CHECKED_IN" = "$VALUE" ]; then
  echo "rotated $SERVICE/$KEY in $ENVIRONMENT" >&2
  echo "verify per docs/runbooks/security/rotation-provider-api-keys.md (or rotation-webhook-secrets.md)." >&2
else
  echo "ERROR: rotation did not persist — your identity may lack GetSecretValue on some app-secrets ARN." >&2
  exit 1
fi