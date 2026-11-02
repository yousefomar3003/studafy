#!/usr/bin/env bash
# Rollback rehearsal for a schema upgrade, against a scratch database on the disposable test-postgres
# (db/compose.yml via compose.yml). Studafy has no down migrations (docs/database/migration-policy.md):
# a bad upgrade is recovered by restoring the pre-upgrade snapshot, then rolling forward again. This
# script rehearses exactly that and proves each step with schema and data fingerprints:
#
#   1. base     migrate the scratch database to <base-ref>'s migrations, seed it with <base-ref>'s
#               demo tenant, fingerprint, and take a pg_dump snapshot
#   2. up       migrate to the working tree's migrations              -> fingerprint "head"
#   3. down     drop the database and restore the snapshot            -> must equal "base" exactly
#   4. up again migrate to the working tree's migrations once more    -> must equal "head"
#
# Schema fingerprint: sha256 of `pg_dump --schema-only` (privileges included, pg_dump's per-run
# \restrict token stripped). Data fingerprint: per leaf table, row count plus md5 over every row in a
# stable order (schema_migrations only by version/name/checksum, since applied_at changes per run).
# Any mismatch on step 3 or 4 is data loss or drift and fails the run. Rows that step 2 itself
# changes are listed, not failed: a migration may legitimately rewrite data, but it must be visible.
#
# If step 2 is refused (the runner rejects history it cannot reconcile, e.g. a renumbered migration),
# the rehearsal checks the refused upgrade left the database untouched, restores the snapshot, and
# exits non-zero with the runner's message.
#
# Usage: scripts/migration-rollback-rehearsal.sh <base-ref>
#   e.g. scripts/migration-rollback-rehearsal.sh 53fa21b7
# Requires: docker (test-postgres running: `bun run db:up`), bun, git. The scratch database is dropped
# on exit; KEEP_SCRATCH=1 keeps it and the work directory for inspection.
set -euo pipefail

BASE_REF="${1:?usage: migration-rollback-rehearsal.sh <base-ref>}"
REPO="$(git rev-parse --show-toplevel)"
BASE_SHA="$(git -C "$REPO" rev-parse --short "$BASE_REF^{commit}")"
DB="rehearsal_${BASE_SHA}_$$"
PGUSER_="${POSTGRES_USER:-studafy_test}"
PGPASS_="${POSTGRES_PASSWORD:-studafy_test}"
PGPORT_="${TEST_POSTGRES_PORT:-54329}"
URL="postgresql://${PGUSER_}:${PGPASS_}@127.0.0.1:${PGPORT_}/${DB}?sslmode=disable"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rollback-rehearsal.XXXXXX")"

pg() { docker compose -f "$REPO/compose.yml" exec -T test-postgres "$@"; }
psql_() { pg psql -X -q -v ON_ERROR_STOP=1 -U "$PGUSER_" "$@"; }

cleanup() {
  if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    echo "kept database $DB and $WORK"
  else
    psql_ -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "DROP DATABASE IF EXISTS \"${DB}_fp\" WITH (FORCE)" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# <base-ref>'s migrations, runner and seeds, using this checkout's installed dependencies (the seeds
# and runner import only node builtins and `postgres`).
mkdir -p "$WORK/base"
git -C "$REPO" archive "$BASE_SHA" db packages/db | tar -x -C "$WORK/base"
ln -s "$REPO/node_modules" "$WORK/base/node_modules"
ln -s "$REPO/packages/db/node_modules" "$WORK/base/packages/db/node_modules"

run_env() { env -u DATABASE_HOST -u DATABASE_PORT -u DATABASE_NAME -u DATABASE_USER -u DATABASE_PASSWORD \
  DATABASE_URL="$URL" DATABASE_SSL_MODE=disable NODE_ENV=development APP_ENV=development "$@"; }
migrate() { # <tree>
  (cd "$1" && run_env MIGRATIONS_DIR="$1/db/migrations" bun --no-env-file packages/db/src/cli.ts migrate)
}

fingerprint() { # <label>
  # pg_dump prints a stored expression as it was parsed, and a restore re-parses it (e.g. a nested
  # `(a AND b) AND c` comes back flattened), so the dump is canonicalised by one schema-only round trip
  # through a throwaway database: every state is compared in the same re-parsed form.
  psql_ -d postgres -c "CREATE DATABASE \"${DB}_fp\""
  pg pg_dump -U "$PGUSER_" -d "$DB" --schema-only | psql_ -d "${DB}_fp" >/dev/null
  pg pg_dump -U "$PGUSER_" -d "${DB}_fp" --schema-only | grep -vE '^\\(un)?restrict ' >"$WORK/$1.schema.sql"
  psql_ -d postgres -c "DROP DATABASE \"${DB}_fp\""
  psql_ -d "$DB" -At -F $'\t' >"$WORK/$1.data.tsv" <<'SQL'
DO $$
DECLARE
  r record; n bigint; h text; st text; excl text[];
  -- A value a migration generates as it runs (new row ids, timestamps) differs on every run.
  volatile constant text := '(now\(|current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp|gen_random_uuid)';
BEGIN
  CREATE TEMP TABLE fp (tbl text, rows bigint, digest text, stable text) ON COMMIT PRESERVE ROWS;
  FOR r IN
    SELECT c.oid::regclass AS rel, format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  LOOP
    IF r.name LIKE '%.schema_migrations' THEN
      EXECUTE format('SELECT count(*), md5(coalesce(string_agg(concat_ws(%L, version, name, checksum), %L ORDER BY version), %L)) FROM %s',
        '|', E'\n', '', r.rel) INTO n, h;
      st := h;
    ELSE
      EXECUTE format('SELECT count(*), md5(coalesce(string_agg(t::text, %L ORDER BY t::text), %L)) FROM %s t',
        E'\n', '', r.rel) INTO n, h;
      -- The "stable" digest leaves out columns whose default is generated at write time, and foreign
      -- keys to such columns, so two runs of the same upgrade can be compared.
      excl := ARRAY(
        SELECT a.attname::text FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = r.rel AND pg_get_expr(d.adbin, d.adrelid) ~* volatile
        UNION
        SELECT a.attname::text FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(col, fcol)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col
        JOIN pg_attrdef d ON d.adrelid = c.confrelid AND d.adnum = k.fcol
        WHERE c.contype = 'f' AND c.conrelid = r.rel AND pg_get_expr(d.adbin, d.adrelid) ~* volatile);
      EXECUTE format('SELECT md5(coalesce(string_agg(v, %L ORDER BY v), %L)) FROM (SELECT (to_jsonb(t) - %L::text[])::text AS v FROM %s t) s',
        E'\n', '', excl, r.rel) INTO st;
    END IF;
    INSERT INTO fp VALUES (r.name, n, h, st);
  END LOOP;
END $$;
SELECT tbl, rows, digest, stable FROM fp ORDER BY tbl;
SQL
  printf '%-10s schema %s  data %s  (%s tables, %s rows)\n' "$1" \
    "$(shasum -a 256 <"$WORK/$1.schema.sql" | cut -c1-16)" \
    "$(cut -f1-3 "$WORK/$1.data.tsv" | shasum -a 256 | cut -c1-16)" \
    "$(wc -l <"$WORK/$1.data.tsv" | tr -d ' ')" \
    "$(awk -F'\t' '{s+=$2} END {print s+0}' "$WORK/$1.data.tsv")"
}

same() { # <a> <b> [stable]: non-zero, showing the difference, unless schema and data both match.
  # Data is compared on every value by default; `stable` compares the stable digest instead.
  local ok=0 fields=1-3
  [ "${3:-}" = "stable" ] && fields=1,2,4
  cmp -s "$WORK/$1.schema.sql" "$WORK/$2.schema.sql" || { echo "SCHEMA DIFFERS ($1 vs $2):"; diff "$WORK/$1.schema.sql" "$WORK/$2.schema.sql" | head -40; ok=1; }
  cmp -s <(cut -f"$fields" "$WORK/$1.data.tsv") <(cut -f"$fields" "$WORK/$2.data.tsv") ||
    { echo "DATA DIFFERS ($1 vs $2), table / rows / digest:"; diff <(cut -f"$fields" "$WORK/$1.data.tsv") <(cut -f"$fields" "$WORK/$2.data.tsv") | head -40; ok=1; }
  return $ok
}

restore_snapshot() {
  psql_ -d postgres -c "DROP DATABASE \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\""
  pg pg_restore -U "$PGUSER_" -d "$DB" --exit-on-error <"$WORK/base.dump"
}

echo "== scratch database $DB (base $BASE_SHA -> working tree)"
psql_ -d postgres -c "CREATE DATABASE \"$DB\""

echo "== 1. base: migrate + seed at $BASE_SHA"
migrate "$WORK/base" | tail -1
(cd "$WORK/base" && run_env bun --no-env-file db/seeds/seed.ts | tail -1)
fingerprint base
pg pg_dump -U "$PGUSER_" -d "$DB" -Fc >"$WORK/base.dump"

echo "== 2. up: migrate to the working tree"
if ! migrate "$REPO" >"$WORK/up.log" 2>&1; then
  echo "UPGRADE REFUSED:"; sed 's/^/  /' "$WORK/up.log" | tail -5
  fingerprint refused
  if same base refused; then echo "refused upgrade left schema and data untouched"; else echo "PARTIAL UPGRADE LEFT BEHIND"; fi
  restore_snapshot; fingerprint restored; same base restored && echo "snapshot restore verified"
  exit 1
fi
grep -E '^applied ' "$WORK/up.log" | sed 's/^/  /'
fingerprint head
echo "  tables the upgrade changed (table / rows / digest, < base > head):"
changed="$(diff <(cut -f1-3 "$WORK/base.data.tsv") <(cut -f1-3 "$WORK/head.data.tsv") | grep -E '^[<>]' || true)"
[ -n "$changed" ] && echo "$changed" | sed 's/^/    /' || echo "    none"
# A table that existed at base must not lose rows on the way up unless a migration means it to.
lost="$(LC_ALL=C join -t $'\t' <(cut -f1,2 "$WORK/base.data.tsv" | LC_ALL=C sort) <(cut -f1,2 "$WORK/head.data.tsv" | LC_ALL=C sort) | awk -F'\t' '$3 < $2 {print "    " $1 ": " $2 " -> " $3}')"
[ -z "$lost" ] && echo "  no base table lost rows" || { echo "  ROWS REMOVED BY THE UPGRADE (confirm each is intended):"; echo "$lost"; }

echo "== 3. down: restore the pre-upgrade snapshot"
restore_snapshot
fingerprint restored
same base restored
echo "  restored database is identical to base: zero data loss"

echo "== 4. up again: migrate to the working tree"
migrate "$REPO" | tail -1
fingerprint head2
same head head2 stable
echo "  second upgrade is identical to the first (values generated at migration time aside)"

echo "== PASS"
