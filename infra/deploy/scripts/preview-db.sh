#!/usr/bin/env bash
# Per-PR database lifecycle on the ONE shared preview Postgres server.
#
#   preview-db.sh create <pr-number>   drop-if-exists then create preview_pr_<n> (idempotent:
#                                      a preview is ephemeral, so every deploy starts clean)
#   preview-db.sh drop   <pr-number>   drop preview_pr_<n> with (force), no error if absent
#   preview-db.sh url    <pr-number>   print the connection URL for preview_pr_<n> (no DDL)
#   preview-db.sh exists <pr-number>   exit 0 if preview_pr_<n> exists, 1 if not (for teardown
#                                      verification)
#
# Requires: psql on PATH, and the PREVIEW_DATABASE_ADMIN_URL environment variable — an admin
# connection string to the shared preview server (…/postgres). Its password is the only secret
# here; nothing in this script echoes it (the `url` subcommand prints a string that contains it,
# which is why the caller must treat that output as sensitive — pr-preview.yml keeps it masked).
#
# The shared server MUST NOT be RDS and MUST NOT be a staging/production host: db/seeds/guard.ts
# refuses to seed against those with no override, so a preview_pr_<n> on such a host could be
# migrated but never seeded. See infra/deploy/environments/preview.env's PREVIEW_DB_HOST note.
set -euo pipefail

ACTION="${1:?usage: preview-db.sh <create|drop|url|exists> <pr-number>}"
PR_NUMBER="${2:?usage: preview-db.sh <create|drop|url|exists> <pr-number>}"

case "$PR_NUMBER" in
  '' | *[!0-9]*) echo "pr-number must be a positive integer, got '$PR_NUMBER'" >&2; exit 2 ;;
esac
: "${PREVIEW_DATABASE_ADMIN_URL:?PREVIEW_DATABASE_ADMIN_URL must be set}"

DB_NAME="preview_pr_${PR_NUMBER}"

# Swap the database path of the admin URL for the per-PR database, and force sslmode=disable
# (the preview server terminates plaintext on a private network — see preview.env). Strips any
# existing query string first, then any existing /<database> path segment.
base="${PREVIEW_DATABASE_ADMIN_URL%%\?*}"
per_pr_url="${base%/*}/${DB_NAME}?sslmode=disable"

psql_admin() {
  psql "$PREVIEW_DATABASE_ADMIN_URL" --no-psqlrc --quiet --tuples-only \
    --set ON_ERROR_STOP=1 "$@"
}

case "$ACTION" in
  create)
    # CREATE DATABASE cannot run inside a transaction block; each -c is its own autocommit
    # statement, which is what we want here.
    psql_admin -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)" \
               -c "CREATE DATABASE \"${DB_NAME}\""
    echo "created ${DB_NAME}" >&2
    echo "$per_pr_url"
    ;;
  drop)
    psql_admin -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)"
    echo "dropped ${DB_NAME} (if it existed)" >&2
    ;;
  url)
    echo "$per_pr_url"
    ;;
  exists)
    found="$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | tr -d '[:space:]')"
    [ "$found" = "1" ]
    ;;
  *)
    echo "unknown action '$ACTION' (expected create, drop, url, or exists)" >&2
    exit 2
    ;;
esac
