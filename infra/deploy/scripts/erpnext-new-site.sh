#!/usr/bin/env bash
# Creates one school's Frappe site on the ERPNext plane (site-per-school tenancy) and gets it ready
# for apps/api, by running modules/erpnext's inert site-setup task definition via `aws ecs run-task`
# with an overridden command. Run by hand once per school -- a Frappe site can only be made by bench,
# never over the REST API, so apps/api cannot do this itself.
#
# Usage:
#   erpnext-new-site.sh <staging|prod> <site-hostname> --school-id <uuid> --company "<name>" \
#     --abbr <ABBR> [--currency JOD] [--country Jordan] [--seed]
#
# The school's id, site hostname, company name and abbreviation are on its app.erpnext_site_configs row,
# which provisioning writes as 'pending' when the school verifies its email
# (<slug>.<ERPNEXT_SITE_DOMAIN>). Three steps, each its own one-shot task:
#
#   1. `bench new-site` with erpnext + education installed.
#   2. `python -m erpnext_seed.provision <site> setup` (infra/deploy/erpnext/seed/provision.py):
#      finishes ERPNext's setup wizard -- the school's Company, chart of accounts, fiscal year and
#      currency -- gives the integration user the shared credential apps/api uses for every site
#      (ERPNEXT_API_KEY), creates the Scholarship Award doctype, and installs the webhooks that tell
#      apps/api about submitted invoices, payments and fees: posted to the tier's API_ORIGIN, stamped
#      with the school id, signed with ERPNEXT_WEBHOOK_SECRET (both secrets from the api app secret,
#      passed in as environment variables).
#   3. With --seed only: the synthetic fixtures in infra/deploy/erpnext/seed/ (a demo tenant, never a
#      real school).
#
# Nothing in apps/api needs touching afterwards: on the school's next finance request the API finds
# the site answering, records its company, and marks the row 'completed'
# (modules/finance/client/credential-resolver.ts).
#
# Requires: aws cli, jq on PATH; an assumed identity with ecs:RunTask/DescribeTasks on the
# site-setup task definition and secretsmanager:GetSecretValue on the mariadb connection secret and
# this environment's erpnext and api app-secrets containers -- an interactive operator needs their
# own equivalent access, since this script reads those secrets directly to pass them to the task.
set -euo pipefail

USAGE='usage: erpnext-new-site.sh <staging|prod> <site-hostname> --school-id <uuid> --company "<name>" --abbr <ABBR> [--currency JOD] [--country Jordan] [--seed]'
ENVIRONMENT="${1:?$USAGE}"
SITE_HOSTNAME="${2:?$USAGE}"
shift 2

SCHOOL_ID=""
COMPANY=""
ABBR=""
CURRENCY="JOD"
COUNTRY="Jordan"
SEED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --school-id) SCHOOL_ID="${2:?$USAGE}"; shift 2 ;;
    --company) COMPANY="${2:?$USAGE}"; shift 2 ;;
    --abbr) ABBR="${2:?$USAGE}"; shift 2 ;;
    --currency) CURRENCY="${2:?$USAGE}"; shift 2 ;;
    --country) COUNTRY="${2:?$USAGE}"; shift 2 ;;
    --seed) SEED=1; shift ;;
    *) echo "$USAGE" >&2; exit 1 ;;
  esac
done
if [ -z "$SCHOOL_ID" ] || [ -z "$COMPANY" ] || [ -z "$ABBR" ]; then
  echo "$USAGE" >&2
  exit 1
fi

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
secret_field() {
  aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text | jq -r --arg k "$2" '.[$k] // empty'
}

TASK_DEF_ARN="$(tf_output erpnext_site_setup_task_definition_arn)"
CLUSTER="$(tf_output compute_ecs_cluster_name)"
SECURITY_GROUP="$(tf_output erpnext_security_group_id)"
SUBNETS_JSON="$(terraform -chdir="$TF_DIR" output -json private_app_subnet_ids)"
SECRET_ARNS_JSON="$(terraform -chdir="$TF_DIR" output -json secrets_service_secret_arns)"

MARIADB_SECRET_ARN="$(tf_output mariadb_connection_secret_arn)"
MARIADB_ROOT_USER="$(secret_field "$MARIADB_SECRET_ARN" username)"
MARIADB_ROOT_PASSWORD="$(secret_field "$MARIADB_SECRET_ARN" password)"
ADMIN_PASSWORD="$(secret_field "$(jq -r '.erpnext' <<<"$SECRET_ARNS_JSON")" ADMIN_PASSWORD)"
INTEGRATION_KEY="$(secret_field "$(jq -r '.api' <<<"$SECRET_ARNS_JSON")" ERPNEXT_API_KEY)"
WEBHOOK_SECRET="$(secret_field "$(jq -r '.api' <<<"$SECRET_ARNS_JSON")" ERPNEXT_WEBHOOK_SECRET)"
# The public API address the site's webhooks post to (its tier's API_ORIGIN).
API_ORIGIN="$(sed -n 's/^API_ORIGIN=//p' "$ROOT/infra/deploy/environments/$ENVIRONMENT.env")"

case "$INTEGRATION_KEY" in
  ?*:?*) ;;
  *)
    echo "the api app secret has no ERPNEXT_API_KEY of the form <api_key>:<api_secret> — set it first (docs/runbooks/production-secrets.md)" >&2
    exit 1
    ;;
esac
if [ -z "$WEBHOOK_SECRET" ] || [ -z "$API_ORIGIN" ]; then
  echo "the api app secret needs ERPNEXT_WEBHOOK_SECRET and environments/$ENVIRONMENT.env an API_ORIGIN — the site's webhooks post to it (docs/runbooks/production-secrets.md)" >&2
  exit 1
fi

# Runs the site-setup task with the given container overrides (JSON) and fails on a non-zero exit.
# Credentials travel in the run-task overrides (visible in that API call's parameters / CloudTrail,
# not injected via ECS `secrets` like the long-running services get) -- an accepted trade-off for a
# human-operated one-off admin command; revisit if this ever needs to run unattended.
run_site_task() {
  local what="$1" overrides="$2" task_arn exit_code
  task_arn="$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$TASK_DEF_ARN" \
    --launch-type FARGATE \
    --network-configuration "{\"awsvpcConfiguration\":{\"subnets\":${SUBNETS_JSON},\"securityGroups\":[\"${SECURITY_GROUP}\"],\"assignPublicIp\":\"DISABLED\"}}" \
    --overrides "$overrides" \
    --query 'tasks[0].taskArn' --output text)"
  echo "waiting for $what: $task_arn" >&2
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
  exit_code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text)"
  if [ "$exit_code" != "0" ]; then
    echo "$what failed (exit $exit_code) — check /${ENVIRONMENT}/ecs/erpnext-site-setup in CloudWatch Logs" >&2
    exit 1
  fi
}

echo "creating site $SITE_HOSTNAME in $ENVIRONMENT (bench new-site, not idempotent — do not re-run against an existing site)" >&2
run_site_task "bench new-site" "$(jq -n \
  --arg site "$SITE_HOSTNAME" \
  --arg root_user "$MARIADB_ROOT_USER" \
  --arg root_password "$MARIADB_ROOT_PASSWORD" \
  --arg admin_password "$ADMIN_PASSWORD" \
  '{
    containerOverrides: [{
      name: "site-setup",
      command: ["bench", "new-site", $site,
                "--db-root-username", $root_user,
                "--db-root-password", $root_password,
                "--admin-password", $admin_password,
                "--install-app", "erpnext",
                "--install-app", "education",
                "--mariadb-user-host-login-scope=%"]
    }]
  }')"

# provision.py runs as a module from the sites directory, not through `bench execute`, which
# swallows the real exception and reports a misleading NameError instead.
echo "finishing ERPNext setup on $SITE_HOSTNAME (company: $COMPANY)" >&2
run_site_task "site setup" "$(jq -n \
  --arg site "$SITE_HOSTNAME" \
  --arg company "$COMPANY" \
  --arg abbr "$ABBR" \
  --arg currency "$CURRENCY" \
  --arg country "$COUNTRY" \
  --arg key "$INTEGRATION_KEY" \
  --arg webhook_secret "$WEBHOOK_SECRET" \
  --arg school_id "$SCHOOL_ID" \
  --arg api_url "$API_ORIGIN" \
  '{
    containerOverrides: [{
      name: "site-setup",
      environment: [
        {name: "STUDAFY_ERPNEXT_API_KEY", value: $key},
        {name: "STUDAFY_ERPNEXT_WEBHOOK_SECRET", value: $webhook_secret}
      ],
      command: ["bash", "-c",
                "cd sites && exec ../env/bin/python -m erpnext_seed.provision \"$0\" setup --company \"$1\" --abbr \"$2\" --currency \"$3\" --country \"$4\" --school-id \"$5\" --api-url \"$6\"",
                $site, $company, $abbr, $currency, $country, $school_id, $api_url]
    }]
  }')"

if [ "$SEED" = 1 ]; then
  echo "loading synthetic seed fixtures (infra/deploy/erpnext/seed/) into $SITE_HOSTNAME" >&2
  run_site_task "seed fixtures" "$(jq -n --arg site "$SITE_HOSTNAME" '{
    containerOverrides: [{
      name: "site-setup",
      command: ["bash", "-c",
                "cd sites && exec ../env/bin/python -m erpnext_seed.provision \"$0\" fixtures",
                $site]
    }]
  }')"
fi

echo "site $SITE_HOSTNAME is ready; the school's finance activates on its next request" >&2
