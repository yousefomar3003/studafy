#!/usr/bin/env bash
# Shared helpers for every infra/tools/integrity script. Sourced, never executed directly.

log() { echo "[integrity] $*" >&2; }

fail() {
  log "ERROR: $*"
  exit 1
}

require_uuid() {
  local value="$1" label="$2"
  [[ "$value" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || fail "$label must be a UUID, got: $value"
}

# Resolves libpq's standard PG* environment variables for the instance the caller should talk to.
# Mirrors infra/tools/tenant-restore/lib/common.sh exactly: either CONNECTION_SECRET_ARN+AWS_REGION
# (AWS Secrets Manager master credential) or plain PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
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

# Whether the connected role can SET ROLE studafy_app -- the pre-condition every integrity check's
# RLS behavioural probes rely on (the same role the API itself runs as). Never assumed: probed, for
# the same reason tenant-restore probes can_set_role_studafy_admin (see that directory's README,
# "Known gaps").
can_set_role_studafy_app() {
  psql -tAc "SET ROLE studafy_app" >/dev/null 2>&1
}

# Whether the connected role is a superuser. Only drill-corruption.sh needs this -- its injections
# include ALTER TABLE app.students DISABLE ROW LEVEL SECURITY, which requires superuser.
require_superuser() {
  psql -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user" | grep -qx t \
    || fail "connected role is not a superuser -- required for drill-corruption.sh's RLS-disabling injection"
}

# Prints "school_id<TAB>slug<TAB>name" for the school identified by --school-slug or --school-id.
# Matching a school is intentionally exact (slug equality, not ILIKE) and validates existence on the
# connected instance, so a typo against the wrong environment fails loudly instead of producing an
# empty report.
resolve_school() {
  local slug="$1" school_id="$2" row
  if [ -n "$slug" ]; then
    row="$(psql -tA -F $'\t' -c \
      "SELECT id, slug, name FROM app.schools WHERE slug = '$slug'"
    )"
    [ -n "$row" ] || fail "no school with slug '$slug' on $PGHOST/$PGDATABASE"
  else
    row="$(psql -tA -F $'\t' -c \
      "SELECT id, slug, name FROM app.schools WHERE id = '$school_id'"
    )"
    [ -n "$row" ] || fail "no school with id '$school_id' on $PGHOST/$PGDATABASE"
  fi
  printf '%s' "$row"
}

# Resolves a real ORG_ADMIN or SUPER_ADMIN user_id for the school. The RLS behavioural probes set
# app.user_id to this value so that any role_scope_visibility policy layered over tenant_isolation
# (db/migrations/000037) resolves its admin escape hatch instead of raising on current_user_id().
resolve_admin_user_id() {
  local school_id="$1" admin_user_id
  admin_user_id="$(psql -tAc \
    "SELECT set_config('app.school_id', '$school_id', false)" \
    -c "SELECT ur.user_id FROM app.user_roles ur WHERE ur.school_id = '$school_id' AND ur.role IN ('ORG_ADMIN', 'SUPER_ADMIN') ORDER BY ur.user_id LIMIT 1" \
    | tail -n1 \
  )"
  [ -n "$admin_user_id" ] \
    || fail "no ORG_ADMIN/SUPER_ADMIN user_role found for school $school_id -- required as the admin actor for RLS spot probes"
  printf '%s' "$admin_user_id"
}

# Hosts the disposable local/CI Postgres (db/compose.yml) is reachable at -- the same trust boundary
# db/seeds/guard.ts already draws. drill-corruption.sh corrupts and deletes rows, so it may only ever
# point at a database like this.
require_loopback_host() {
  local host
  host="$(printf '%s' "$PGHOST" | sed -e 's/^\[//' -e 's/\]$//' | tr '[:upper:]' '[:lower:]')"
  case "$host" in
    localhost|127.0.0.1|::1|0.0.0.0|postgres|db|database|host.docker.internal) ;;
    *)
      if [ "${INTEGRITY_ALLOW_NONLOCAL:-}" = "true" ]; then
        log "WARNING: PGHOST '$PGHOST' is not a recognized local host; proceeding only because INTEGRITY_ALLOW_NONLOCAL=true"
      else
        fail "PGHOST '$PGHOST' is not a recognized local database (see db/seeds/guard.ts); refusing to run the corruption drill anywhere else -- set INTEGRITY_ALLOW_NONLOCAL=true only for a disposable remote CI database"
      fi
      ;;
  esac
}