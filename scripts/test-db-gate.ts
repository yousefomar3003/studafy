/**
 * Preloaded by `bun test` in apps/api and apps/workers (their bunfig.toml).
 *
 * Every database-backed test in those packages self-skips when TEST_DATABASE_URL is unset. That is
 * right for the CI "quality" job and for a quick local unit run -- but it also means a database job
 * whose URL went missing reports green while running none of its database tests, and a developer
 * can read "all pass" off a run that never touched Postgres (QA-004).
 *
 * So the skip is never silent, and a job that exists to run them can demand them:
 *   - unset, REQUIRE_DB_TESTS unset  -> one loud banner on stderr, tests skip as before;
 *   - unset, REQUIRE_DB_TESTS=1      -> the run aborts before any test executes.
 */
const required = process.env.REQUIRE_DB_TESTS === "1";

if (!process.env.TEST_DATABASE_URL) {
  const hint =
    "Start the disposable database with `bun run db:up`, then set " +
    "TEST_DATABASE_URL=postgresql://studafy_test:studafy_test@127.0.0.1:54329/postgres?sslmode=disable " +
    "(or run scripts/test-db.sh).";
  if (required) {
    throw new Error(`REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is unset. ${hint}`);
  }
  process.stderr.write(
    "\n*** DB TESTS SKIPPED: TEST_DATABASE_URL is unset, so every database-backed test in this " +
      `package is skipped and a green result does not cover them. ${hint}\n\n`,
  );
}

export {};
