#!/usr/bin/env bash
# Phase C of the tenant-slice restore tool (ST-267): loads a slice extract-tenant-slice.sh produced
# into a target database -- staging for the "restored into staging and validated" acceptance
# criterion, or a real prod recovery once that validation has happened. Recovers exactly one
# school's rows without touching any other tenant's data or rolling back the target database as a
# whole: every table load and its row-count check runs inside one `psql --single-transaction`, so
# any single failure (a checksum mismatch caught before the transaction even opens, a duplicate
# key, a row-count mismatch) aborts the whole run and leaves the target completely unmodified.
#
# Each slice file is plain INSERT statements (extract-tenant-slice.sh's own README section
# explains why: `COPY ... FROM` is unconditionally rejected by PostgreSQL on a row-security-enabled
# table for any role that doesn't bypass RLS, no matter the policy), so this script just feeds each
# file to psql with -f, in the same ascending-FK-level order the manifest already carries them in.
#
# Usage:
#   apply-tenant-slice.sh --manifest <path/to/manifest.json> --confirm-school-id <uuid>
#     [--table <name>]...
#
# --confirm-school-id must repeat the manifest's own school_id verbatim -- a deliberate, cheap
# "are you sure this is the tenant you mean" gate on the one step here that writes to a live
# database, not a full interactive prompt (which would make this unautomatable and untestable).
#
# --table restricts which of the manifest's tables get applied (repeatable; default: every table
# the manifest carries). The realistic recovery case is usually "this school's assignments got
# deleted", not "this whole school vanished" -- applying only the affected table(s) is what keeps
# this a *slice* restore rather than a full-tenant one, and it's also what makes re-applying the
# same manifest into a database that still has most of this school's data intact possible at all
# (loading an untouched table's already-present rows again is a duplicate-key error, not a no-op).
#
# Connection: see lib/common.sh's resolve_pg_connection, pointed at the TARGET database (staging or
# prod) -- never the scratch/source instance extract-tenant-slice.sh read from.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

MANIFEST=""
CONFIRM_SCHOOL_ID=""
declare -a ONLY_TABLES=()

usage() {
  cat >&2 <<'EOF'
Usage: apply-tenant-slice.sh --manifest <path/to/manifest.json> --confirm-school-id <uuid>
         [--table <name>]...
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --confirm-school-id) CONFIRM_SCHOOL_ID="$2"; shift 2 ;;
    --table) ONLY_TABLES+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

[ -n "$MANIFEST" ] || { usage; fail "--manifest is required"; }
[ -f "$MANIFEST" ] || fail "manifest not found: $MANIFEST"
[ -n "$CONFIRM_SCHOOL_ID" ] || { usage; fail "--confirm-school-id is required"; }

SCHOOL_ID="$(jq -r '.school_id' "$MANIFEST")"
SCHOOL_NAME="$(jq -r '.school_name' "$MANIFEST")"
require_uuid "$SCHOOL_ID" "manifest school_id"
[ "$CONFIRM_SCHOOL_ID" = "$SCHOOL_ID" ] \
  || fail "--confirm-school-id ($CONFIRM_SCHOOL_ID) does not match the manifest's school_id ($SCHOOL_ID) for '$SCHOOL_NAME' -- refusing to apply"

MANIFEST_DIR="$(cd "$(dirname "$MANIFEST")" && pwd)"

# Empty ONLY_JSON means "no --table given, apply everything" -- selected_tables below then passes
# every manifest table through unfiltered.
ONLY_JSON="$(printf '%s\n' "${ONLY_TABLES[@]+"${ONLY_TABLES[@]}"}" | jq -R -s 'split("\n") | map(select(length > 0))')"
selected_tables() {
  jq --argjson only "$ONLY_JSON" \
    '.tables | if ($only | length) == 0 then . else map(select(.table as $t | $only | index($t) != null)) end' \
    "$MANIFEST"
}

for wanted in "${ONLY_TABLES[@]+"${ONLY_TABLES[@]}"}"; do
  jq -e --arg t "$wanted" '.tables[] | select(.table == $t)' "$MANIFEST" >/dev/null \
    || fail "--table $wanted is not in this manifest"
done

TABLE_COUNT="$(selected_tables | jq 'length')"
[ "$TABLE_COUNT" -gt 0 ] || fail "no tables selected to apply"

log "verifying $TABLE_COUNT slice file checksum(s) before touching the target database"
while IFS=$'\t' read -r table file expected_sha256; do
  path="$MANIFEST_DIR/$file"
  [ -f "$path" ] || fail "slice file missing: $path (table $table)"
  actual_sha256="$(sha256_file "$path")"
  [ "$actual_sha256" = "$expected_sha256" ] \
    || fail "checksum mismatch for $table: manifest says $expected_sha256, file is $actual_sha256 -- slice may be corrupted or tampered with"
done < <(selected_tables | jq -r '.[] | [.table, .file, .sha256] | @tsv')
log "all slice files verified against the manifest"

resolve_pg_connection

log "verifying school $SCHOOL_ID ('$SCHOOL_NAME') exists on target $PGHOST/$PGDATABASE"
TARGET_SCHOOL_NAME="$(psql -tAc "SELECT name FROM app.schools WHERE id = '$SCHOOL_ID'")"
[ -n "$TARGET_SCHOOL_NAME" ] \
  || fail "school $SCHOOL_ID not found on target $PGHOST/$PGDATABASE -- this tool restores a slice of an EXISTING school's deleted data, it does not recreate the school itself"

# Unlike extract-tenant-slice.sh, this is a soft fallback, not a hard requirement: INSERT's
# tenant_isolation WITH CHECK passes for any role once app.school_id matches (the policy is FOR ALL
# TO PUBLIC), so correctness here rests on the GUC and an INSERT grant, not on which role holds the
# session -- studafy_admin (the table owner) is simply the closest match to "the system is
# performing this write on nobody's behalf", the same reasoning apps/api's own withSystemTx
# documents for itself.
ROLE_CLAUSE=()
if can_set_role_studafy_admin; then
  log "connected role can SET ROLE studafy_admin -- applying as the system actor, matching apps/api's withSystemTx"
  ROLE_CLAUSE=(-c "SET LOCAL ROLE studafy_admin")
else
  log "connected role cannot SET ROLE studafy_admin -- proceeding as the connection's own role (see README's Known gaps)"
fi

declare -a PSQL_ARGS=(-v ON_ERROR_STOP=1 --single-transaction)
PSQL_ARGS+=("${ROLE_CLAUSE[@]}")
PSQL_ARGS+=(-c "SELECT set_config('app.school_id', '$SCHOOL_ID', true)")

# manifest.tables is already in ascending FK-dependency order (discover-tenant-tables.sql's own
# ORDER BY lvl, preserved verbatim by extract-tenant-slice.sh) -- loading in that order satisfies
# every FK between tenant tables without deferring constraints.
while IFS=$'\t' read -r table file row_count; do
  path="$MANIFEST_DIR/$file"
  PSQL_ARGS+=(-f "$path")
  PSQL_ARGS+=(-c "DO \$\$ BEGIN IF (SELECT count(*) FROM app.\"$table\" WHERE school_id = '$SCHOOL_ID') < $row_count THEN RAISE EXCEPTION 'row count for $table is below the $row_count rows just loaded -- aborting'; END IF; END \$\$;")
done < <(selected_tables | jq -r '.[] | [.table, .file, .row_count] | @tsv')

log "applying $TABLE_COUNT table(s) to $PGHOST/$PGDATABASE inside one transaction"
psql "${PSQL_ARGS[@]}" >/dev/null
log "applied and committed. Run this school's own application-level checks next -- this tool restores rows, it does not certify business correctness."
