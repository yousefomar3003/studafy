# Flaky-test quarantine

A flaky test passes and fails without the code under test changing. It is worse than a plainly
failing test: once people learn to re-run CI to turn it green, the real regressions it would have
caught get re-run away with it. This is the process for pulling one out of the merge-blocking path
without losing track of it.

Scope: the database-backed suites behind `integration-suite` (`cross-tenant-security`,
`api-integration`, `database-migrations`) and the JS/TS suites in `quality`. The Flutter and
Playwright suites carry their own flake handling — `mobile-unit-coverage` and the `<2%` flake-rate
gate in `e2e-critical` — and are out of scope here.

## What is, and isn't, a quarantine candidate

- **Quarantine:** a test that has failed in CI on changes unrelated to what it covers, or fails
  intermittently when run locally in a loop, _and_ whose failure is not a real defect in the code
  under test.
- **Not a quarantine — fix it:** a test that fails deterministically. That is the build doing its
  job; fix the code or the test.
- **Not a quarantine — it's a known blocker:** a test skipped because a feature is unfinished or a
  dependency is absent (`test.skipIf(!integrationEnabled)`, the grade-publish skip in
  [`mobile-integration-suite.md`](./mobile-integration-suite.md)). Those are deliberate and stay
  skipped until the blocker clears. A quarantine is temporary and tracks an _unwanted_ loss of
  coverage that someone owns getting back.

## Process

1. **Open a ticket.** One per quarantined test, carrying the failing run links, the logs, and an
   owner. Nothing is quarantined without one — the ticket is what stops the quarantine from
   becoming permanent.
2. **Annotate and skip.** On a `//` comment line directly above the test:
   ```ts
   // QUARANTINE(ST-1234, 2026-09-05): pub/sub NOTIFY races the cache read; ~3% fail rate in CI. Owner: @yousef.
   test.skip("cache invalidation propagates within 5s", async () => {
   ```
   Use `test.skip` / `it.skip` / `describe.skip`. Never comment the body out (it stops compiling
   and type-checking) and never delete it — the skipped test is still the spec for the fix.
3. **Land it on the normal review path.** A quarantine PR touches only that one test and its
   annotation. CI goes green because the test no longer runs.
4. **It stays visible.** `integration-suite` runs `.github/scripts/list-quarantined-tests.sh` on
   every build and writes the full quarantine set to the job summary
   (`bun run test:quarantine-list` prints the same thing locally). There is no separate dashboard;
   that summary is the standing reminder.
5. **Fix or delete within two weeks.** The ticket is the clock. Either the flake is understood and
   the test comes back (remove the annotation, restore `test`), or the test is judged to have no
   value and is deleted with a one-line rationale on the ticket. "Still flaky, still skipped, no
   owner" is not an allowed end state.

## Annotation format

```
QUARANTINE(<ticket>, <YYYY-MM-DD>): <one line — symptom, observed rate, owner>
```

`.github/scripts/list-quarantined-tests.sh` matches `QUARANTINE(...)` in any `*.test.ts` under
`apps/` or `packages/`. Keep it to a single `//` line so the inventory row is readable.

## Why there are no automatic retries

`bun test` has no retry and none is added. A retry converts a flake into a slower green and removes
the pressure to fix it. This process keeps that pressure by making the lost coverage explicit and
time-boxed instead. The Playwright suite in `e2e-critical` retries because its flake sources
(browser and network timing) are different in kind, and it pairs the retries with an explicit
`<2%` flake-rate gate so they can't hide a genuinely broken journey.
