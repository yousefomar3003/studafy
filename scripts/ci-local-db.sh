#!/usr/bin/env bash
# Mirrors the "database-migrations" CI job (.github/workflows/ci.yml) against a disposable local
# Postgres, so migration/RLS/partition regressions surface before a push instead of in CI.
# Skips the slow perf benchmarks (attendance/notifications/audit-logs/hybrid-search) by default;
# pass --full to run those too.
set -uo pipefail

full=0
if [ "${1:-}" = "--full" ]; then
  full=1
fi

cleanup() {
  docker compose -f db/compose.yml down
}
trap cleanup EXIT

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-studafy_ci_only}"
export DATABASE_URL="postgresql://studafy_test:${POSTGRES_PASSWORD}@127.0.0.1:54329/postgres?sslmode=disable"
export TEST_DATABASE_URL="$DATABASE_URL"
export DATABASE_SSL_MODE=disable

echo "==> starting disposable PostgreSQL (pgvector + pg_stat_statements)"
docker compose -f db/compose.yml up -d --wait || exit 1

echo "==> migrate + tenant RLS coverage audit"
bun run db:migrate || exit 1
bun run db:test:rls-coverage || exit 1

echo "==> packages/db unit + integration suite"
(cd packages/db && bun test --max-concurrency=2 --timeout=10000) || exit 1

echo "==> seed integration test (demo tenant + index health)"
(cd packages/db && SEED_INTEGRATION=1 bun test tests/seed.test.ts --timeout 90000) || exit 1

echo "==> partition maintenance (attendance + audit logs, idempotency)"
bun run db:migrate || exit 1
bun run db:attendance:partitions 12 || exit 1
bun run db:attendance:partitions 12 || exit 1
bun run db:audit:partitions 12 || exit 1
bun run db:audit:partitions 12 || exit 1
bun run db:migrate:validate || exit 1

if [ "$full" = 1 ]; then
  echo "==> perf benchmarks (attendance / notifications / audit-logs / hybrid-search)"
  (cd packages/db && ATTENDANCE_BENCHMARK=1 bun test tests/attendance-benchmark.test.ts) || exit 1
  (cd packages/db && NOTIFICATIONS_BENCHMARK=1 bun test tests/notifications-benchmark.test.ts) || exit 1
  (cd packages/db && AUDIT_LOGS_BENCHMARK=1 bun test tests/audit-logs-benchmark.test.ts) || exit 1
  (cd packages/db && MATERIAL_CHUNKS_BENCHMARK=1 bun test tests/material-chunks-benchmark.test.ts --timeout 900000) || exit 1
fi

echo "All database-migration checks passed."
