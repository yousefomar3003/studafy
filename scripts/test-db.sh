#!/usr/bin/env bash
# Run every database-backed test suite against the disposable local Postgres + Redis (QA-004).
#
#   scripts/test-db.sh            # security, auth, integration, full API, db package, workers
#   scripts/test-db.sh --quick    # security, db package, workers only
#   scripts/test-db.sh --keep     # leave the containers running afterwards
#
# Works from any directory, ignores the root .env (whose discrete DATABASE_* values would clash
# with DATABASE_URL), and sets REQUIRE_DB_TESTS=1 so no suite can silently skip its database tests.
# Never points at anything but 127.0.0.1:54329 / :6390 -- the compose.yml "test" profile.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUICK=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO" || exit 1

# A db/compose.yml from before QA-004 created containers with these exact names; compose then
# refuses to create its own. Name them instead of deleting anything without asking.
for name in studafy-test-postgres-1 studafy-test-redis-1; do
  project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$name" 2>/dev/null || true)"
  if [ -n "$project" ] && [ "$project" != "studafy" ]; then
    echo "Container $name belongs to compose project '$project', not 'studafy', and blocks 'bun run db:up'." >&2
    echo "It is a disposable tmpfs test container. Remove it with: docker rm -f $name" >&2
    exit 1
  fi
done

docker compose up -d --wait test-postgres test-redis || exit 1

PASSWORD="${POSTGRES_PASSWORD:-studafy_test}"
export TEST_DATABASE_URL="postgresql://studafy_test:${PASSWORD}@127.0.0.1:54329/postgres?sslmode=disable"
export TEST_REDIS_URL="redis://127.0.0.1:6390"
export REQUIRE_DB_TESTS=1

FAILED=()
run() {
  local label="$1" dir="$2"
  shift 2
  echo
  echo "=== $label"
  # Each suite starts from an empty disposable Redis: rate-limit buckets (some platform-wide, e.g.
  # the member-login global bucket) drained by one suite would otherwise 429 the next one that
  # re-runs the same tests within the refill window. test-redis only, never any other instance.
  docker compose exec -T test-redis redis-cli FLUSHALL >/dev/null || true
  if ! (cd "$REPO/$dir" && "$@"); then
    FAILED+=("$label")
  fi
}

# The API and workers import built workspace packages (dist/ is gitignored).
run "build workspace deps" . bunx turbo run build --filter=@studafy/api^... --filter=@studafy/workers^...

run "api: security" apps/api bun run test:security
if [ "$QUICK" -eq 0 ]; then
  run "api: auth" apps/api bun run test:auth
  run "api: integration" apps/api bun run test:integration
  run "api: full suite" apps/api bun test --timeout 120000
fi

# The db package and workers query the shared database directly, so migrate it first.
run "db: migrate + RLS coverage" packages/db env DATABASE_URL="$TEST_DATABASE_URL" DATABASE_SSL_MODE=disable \
  bash -c 'bun --no-env-file src/cli.ts migrate && bun --no-env-file src/cli.ts rls-coverage'
run "db: package tests" packages/db bun test --max-concurrency=2 --timeout=10000
run "workers" apps/workers env DATABASE_URL="$TEST_DATABASE_URL" bun test

if [ "$KEEP" -eq 0 ]; then
  docker compose rm -sfv test-postgres test-redis >/dev/null 2>&1
fi

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "All database-backed suites passed."
