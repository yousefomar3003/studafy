# Running the database-backed tests locally

Most API and workers tests need a real Postgres (and some need Redis). They **skip** when `TEST_DATABASE_URL` is unset. A plain `bun run test` therefore passes in seconds while covering none of them, and it now prints a `*** DB TESTS SKIPPED` banner when that happens.

## One command

```bash
scripts/test-db.sh           # security, auth, integration, full API suite, db package, workers
scripts/test-db.sh --quick   # security, db package, workers
scripts/test-db.sh --keep    # leave the test containers running afterwards
```

The script works from any directory. Here is what it does:

- Starts `test-postgres` and `test-redis` from the root `compose.yml` (profile `test`), on 127.0.0.1:54329 and 127.0.0.1:6390, with tmpfs storage.
- Exports `TEST_DATABASE_URL` and `TEST_REDIS_URL`, plus `REQUIRE_DB_TESTS=1`, so no suite can skip silently.
- Ignores the root `.env`. Its discrete `DATABASE_HOST/PORT/...` values would otherwise clash with `DATABASE_URL` in `packages/db`.
- Migrates the shared test database and runs the RLS coverage audit before the db-package and workers suites, which query it directly.

## By hand

```bash
bun run db:up
export TEST_DATABASE_URL="postgresql://studafy_test:${POSTGRES_PASSWORD:-studafy_test}@127.0.0.1:54329/postgres?sslmode=disable"
export TEST_REDIS_URL="redis://127.0.0.1:6390"
(cd apps/api && bun run test:security)
```

CI sets `POSTGRES_PASSWORD=studafy_ci_only` before starting the container. Locally the default is `studafy_test`. The URL has to match whichever password the container was created with.

Set `REQUIRE_DB_TESTS=1` to make `bun test` in `apps/api` or `apps/workers` abort instead of skip when the URL is missing. The CI database jobs set it (`scripts/test-db-gate.ts`).

## Troubleshooting

- **`The container name "/studafy-test-postgres-1" is already in use`**. An older `db/compose.yml` (before QA-004) defined its own `postgres`/`redis` services under project `studafy-test`. Those resolved to the same container names, and `files:up`/`erpnext:up` started them. The file no longer does that. Remove the leftover disposable containers once with `docker rm -f studafy-test-postgres-1 studafy-test-redis-1`. `scripts/test-db.sh` detects this case and prints that command.
- **`Cannot read migration directory … packages/db/db/migrations`**. Fixed: `MIGRATIONS_DIR` now defaults to the repository's `db/migrations`, wherever you run from.
- **`flutter analyze` / `flutter test` fail on missing `…/core/api/generated/…` models**. The Dart API client is generated and gitignored. Run `bun run --cwd apps/mobile analyze` (or `test:fresh`), which regenerates it first.
