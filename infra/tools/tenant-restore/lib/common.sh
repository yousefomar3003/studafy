#!/usr/bin/env bash
# Shared helpers for every infra/tools/tenant-restore script (ST-267). Sourced, never executed
# directly.

log() { echo "[tenant-restore] $*" >&2; }

fail() {
  log "ERROR: $*"
  exit 1
}

require_uuid() {
  local value="$1" label="$2"
  [[ "$value" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || fail "$label must be a UUID, got: $value"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Resolves libpq's standard PG* environment variables for the instance this script's caller should
# talk to. Two modes, chosen by which inputs are present -- both end in the same place (PGHOST/
# PGPORT/PGUSER/PGPASSWORD/PGDATABASE exported):
#
#   AWS mode (CONNECTION_SECRET_ARN set): reads the master credential from Secrets Manager, the
#   same secret ST-265's postgres-restore-verify.sh reads (module.postgres.connection_secret_arn /
#   var.postgres_connection_secret_arn on modules/backup's tenant-restore-operator IAM policy).
#   PGHOST_OVERRIDE substitutes the secret's own `.host` field -- needed for extract-tenant-
#   slice.sh, whose target is the scratch instance restore-scratch.sh just created, not the
#   instance the secret's `.host` names.
#
#   Direct mode (CONNECTION_SECRET_ARN unset): PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE must
#   already be set by the caller -- plain libpq env vars, nothing tenant-restore-specific. This is
#   what every script here was validated against locally (db/compose.yml's studafy_test instance),
#   and it is also the escape hatch for a target this tool's own AWS wiring doesn't reach (e.g. a
#   non-AWS staging box), so it stays a first-class mode rather than a test-only shim.
resolve_pg_connection() {
  if [ -n "${CONNECTION_SECRET_ARN:-}" ]; then
    : "${AWS_REGION:?AWS_REGION must be set alongside CONNECTION_SECRET_ARN}"
    command -v aws >/dev/null 2>&1 || fail "CONNECTION_SECRET_ARN is set but the aws CLI is not on PATH"
    log "reading DB credentials from $CONNECTION_SECRET_ARN"
    local secret_json
    secret_json="$(aws secretsmanager get-secret-value --secret-id "$CONNECTION_SECRET_ARN" \
      --region "$AWS_REGION" --query SecretString --output text)" \
      || fail "could not read $CONNECTION_SECRET_ARN"
    PGUSER="$(jq -r '.username' <<<"$secret_json")"
    PGPASSWORD="$(jq -r '.password' <<<"$secret_json")"
    PGDATABASE="$(jq -r '.dbname' <<<"$secret_json")"
    PGPORT="$(jq -r '.port' <<<"$secret_json")"
    PGHOST="${PGHOST_OVERRIDE:-$(jq -r '.host' <<<"$secret_json")}"
    export PGUSER PGPASSWORD PGDATABASE PGPORT PGHOST
  else
    : "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
  fi
  export PGSSLMODE="${PGSSLMODE:-require}"
}

# The default exclusion list (lib/default-excluded-tables.txt), minus comments/blank lines.
load_default_excluded_tables() {
  local lib_dir="$1"
  grep -vE '^\s*(#|$)' "$lib_dir/default-excluded-tables.txt"
}

# Prints "table_name<TAB>lvl" for every discovered tenant table, ascending by lvl -- a valid FK
# load order. Requires resolve_pg_connection to have run first.
discover_tenant_tables() {
  local lib_dir="$1"
  psql -tA -F $'\t' -f "$lib_dir/discover-tenant-tables.sql"
}

# Whether the connected role can SET ROLE studafy_admin (apply-tenant-slice.sh needs this to
# satisfy the tenant_isolation WITH CHECK policy as the system actor, mirroring
# apps/api/src/db/tenant-tx.ts's own withSystemTx). Never assumed -- probed, because which login
# role a given connection secret resolves to is not something this tool controls (see this
# directory's README, "Known gaps").
can_set_role_studafy_admin() {
  psql -tAc "SET ROLE studafy_admin" >/dev/null 2>&1
}
