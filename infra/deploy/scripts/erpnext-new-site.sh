#!/usr/bin/env bash
# Creates one school's Frappe site on the ERPNext plane (site-per-school tenancy) by running
# modules/erpnext's inert site-setup task definition via `aws ecs run-task` with an overridden
# command — the concrete mechanism behind the "seed tenant usable end-to-end" acceptance
# criterion. Not a deploy in infra/deploy/scripts/deploy.sh's sense: `bench new-site` is a one-shot
# job against a specific hostname, run by hand when a school needs a site, not on every merge.
#
# Usage:
#   erpnext-new-site.sh <staging|prod> <site-hostname> [--seed]
#
# --seed additionally runs the fixture loader baked into the erpnext image
# (infra/docker/erpnext.Dockerfile COPYs infra/deploy/erpnext/seed/ in) — clearly-synthetic
# placeholder data (infra/deploy/erpnext/seed/README.md), not real anonymized student records:
# this repo has no production data anywhere to anonymize.
#
# Requires: aws cli, jq on PATH; an assumed identity with ecs:RunTask/DescribeTasks on the
# site-setup task definition and secretsmanager:GetSecretValue on the mariadb connection secret
# and this environment's erpnext app-secrets container (the same policies
# module.secrets.service_iam_policy_arns["erpnext"] already grants the execution role — an
# interactive operator needs their own equivalent access, since this script calls Secrets Manager
# directly rather than relying on ECS's own secrets injection for the site-admin/root credentials
# it needs on the command line).
set -euo pipefail

ENVIRONMENT="${1:?usage: erpnext-new-site.sh <staging|prod> <site-hostname> [--seed]}"
SITE_HOSTNAME="${2:?usage: erpnext-new-site.sh <staging|prod> <site-hostname> [--seed]}"
SEED_FLAG="${3:-}"

case "$ENVIRONMENT" in
  staging | prod) ;;
  *)
    echo "unknown environment '$ENVIRONMENT' (expected staging or prod — the ERPNext plane is not instantiated in dev, see infra/terraform/main.tf's local.erpnext_plane_enabled)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"

tf_output() { terraform -chdir="$TF_DIR" output -raw "$1"; }

TASK_DEF_ARN="$(tf_output erpnext_site_setup_task_definition_arn)"
CLUSTER="$(tf_output compute_ecs_cluster_name)"
SECURITY_GROUP="$(tf_output erpnext_security_group_id)"
SUBNETS_JSON="$(terraform -chdir="$TF_DIR" output -json private_app_subnet_ids)"

MARIADB_SECRET_ARN="$(tf_output mariadb_connection_secret_arn)"
MARIADB_ROOT_USER="$(aws secretsmanager get-secret-value --secret-id "$MARIADB_SECRET_ARN" --query SecretString --output text | jq -r '.username')"
MARIADB_ROOT_PASSWORD="$(aws secretsmanager get-secret-value --secret-id "$MARIADB_SECRET_ARN" --query SecretString --output text | jq -r '.password')"

ERPNEXT_SECRET_ARN="$(terraform -chdir="$TF_DIR" output -json secrets_service_secret_arns | jq -r '.erpnext')"
ADMIN_PASSWORD="$(aws secretsmanager get-secret-value --secret-id "$ERPNEXT_SECRET_ARN" --query SecretString --output text | jq -r '.ADMIN_PASSWORD')"

echo "creating site $SITE_HOSTNAME in $ENVIRONMENT (bench new-site, not idempotent — do not re-run against an existing site)" >&2

# bench flag names (--mariadb-root-username/--mariadb-root-password) match the documented
# frappe_docker contract for the bench version this module targets — verify against the pinned
# infra/docker/erpnext.Dockerfile tag before relying on this against a real cluster, same
# "not exercised against a live account" caveat modules/erpnext/README.md already carries.
#
# Credentials on the command line (visible in this ecs run-task API call's parameters / CloudTrail,
# not injected via ECS `secrets` like the long-running services get) — an accepted trade-off for a
# human-operated one-off admin command; revisit if this ever needs to run unattended.
NEW_SITE_OVERRIDE="$(jq -n \
  --arg site "$SITE_HOSTNAME" \
  --arg root_user "$MARIADB_ROOT_USER" \
  --arg root_password "$MARIADB_ROOT_PASSWORD" \
  --arg admin_password "$ADMIN_PASSWORD" \
  '{
    containerOverrides: [{
      name: "site-setup",
      command: ["bench", "new-site", $site,
                "--mariadb-root-username", $root_user,
                "--mariadb-root-password", $root_password,
                "--admin-password", $admin_password,
                "--install-app", "erpnext",
                "--install-app", "education",
                "--no-mariadb-socket"]
    }]
  }')"

TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF_ARN" \
  --launch-type FARGATE \
  --network-configuration "{\"awsvpcConfiguration\":{\"subnets\":${SUBNETS_JSON},\"securityGroups\":[\"${SECURITY_GROUP}\"],\"assignPublicIp\":\"DISABLED\"}}" \
  --overrides "$NEW_SITE_OVERRIDE" \
  --query 'tasks[0].taskArn' --output text)"

echo "waiting for site-setup task to finish: $TASK_ARN" >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"

if [ "$EXIT_CODE" != "0" ]; then
  echo "bench new-site failed (exit $EXIT_CODE) — check /${ENVIRONMENT}/ecs/erpnext-site-setup in CloudWatch Logs" >&2
  exit 1
fi

echo "site $SITE_HOSTNAME created" >&2

if [ "$SEED_FLAG" = "--seed" ]; then
  echo "loading synthetic seed fixtures (infra/deploy/erpnext/seed/) into $SITE_HOSTNAME" >&2

  SEED_OVERRIDE="$(jq -n --arg site "$SITE_HOSTNAME" '{
    containerOverrides: [{
      name: "site-setup",
      command: ["bench", "--site", $site, "execute", "erpnext_seed.load_fixtures"]
    }]
  }')"

  SEED_TASK_ARN="$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$TASK_DEF_ARN" \
    --launch-type FARGATE \
    --network-configuration "{\"awsvpcConfiguration\":{\"subnets\":${SUBNETS_JSON},\"securityGroups\":[\"${SECURITY_GROUP}\"],\"assignPublicIp\":\"DISABLED\"}}" \
    --overrides "$SEED_OVERRIDE" \
    --query 'tasks[0].taskArn' --output text)"

  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$SEED_TASK_ARN"

  SEED_EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$SEED_TASK_ARN" \
    --query 'tasks[0].containers[0].exitCode' --output text)"

  if [ "$SEED_EXIT_CODE" != "0" ]; then
    echo "seed fixture load failed (exit $SEED_EXIT_CODE) — site $SITE_HOSTNAME exists but is unseeded" >&2
    exit 1
  fi

  echo "seed fixtures loaded into $SITE_HOSTNAME" >&2
fi
