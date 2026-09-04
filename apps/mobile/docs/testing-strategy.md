# Mobile testing strategy

## Layers

| Layer | Where | Runner | What it's for |
| --- | --- | --- | --- |
| Unit + widget | `test/` | `flutter test` (CI: `mobile-unit-coverage`) | Everything that doesn't need a live API: controllers, providers, screens against fake clients, goldens. |
| API integration | `test_integration/` | `dart test test_integration` (CI: `mobile-api-client`, ST-062) | The one thing `flutter test` structurally cannot do -- see below. |

`flutter test` fakes `HttpClient` process-wide (`TestWidgetsFlutterBinding` returns 400 to every
request), so a real network call cannot be exercised there; forcing a real `HttpClient` back in
via `HttpOverrides.runZoned` deadlocks Dio inside that binding's zone. `test_integration/` runs
under plain `dart test`, which never installs that binding, and is where a real call against a
live API belongs (today: `GET /healthz` through the generated client). New tests that need a real
HTTP round trip go there, not in `test/`; everything else -- including every hand-written data
client in `features/*/data/`, exercised against a `Fake`/mocked `Dio` adapter -- belongs in `test/`.

## Coverage gate (ST-245)

`mobile-unit-coverage` (`.github/workflows/ci.yml`) runs `flutter test --coverage` and
`scripts/check_coverage.dart` on every PR. The checker reads `coverage/lcov.info`, buckets every
`lib/` file (excluding the gitignored `core/api/generated/`, which is never hand-tested) into one
of two groups, and fails the build if either group's line coverage drops below the threshold in
`tool/coverage_gates.dart`:

- **API service layer** (80% target): `lib/src/core/api/**` minus `generated/`,
  `lib/src/core/network/**`, and every hand-written `lib/src/features/*/data/**` client -- the
  surfaces `pubspec.yaml`'s `swagger_parser.exclude_tags` pushes out of codegen (see
  `lib/src/core/api/README.md`).
- **packages** (70% target): everything else under `lib/`.

A per-module breakdown and both bucket totals are written to `coverage/coverage-report.md` and
uploaded as the `mobile-coverage-report` PR artifact (also appended to the job summary), so a
reviewer can see which module moved without re-running anything locally.

### The ratchet, and why today's threshold isn't 80/70 yet

`tool/coverage_gates.dart` holds `gateHistory`, an ordered list of `{date, apiServiceLayer,
packages}` entries. `currentCoverageGate` (the last entry) is what CI enforces; `targetCoverageGate`
is the 80%/70% this ticket specifies as the goal. They're different constants on purpose: measured
against this branch, actual coverage was 10.8% API service layer / 57.2% packages -- most of the
hand-written API clients are exercised only through their real callers' widget tests, not directly,
and several feature modules (`core/router`, `features/notifications`, `core/push`) are barely
touched. Gating at 80/70 immediately would fail every PR for pre-existing coverage this ticket
didn't create. `gateHistory` starts a few points under that measured baseline (8% / 50%,
rounded down for headroom) instead, and is a ratchet: `test/tooling/coverage_gates_ratchet_test.dart`
fails if any entry lowers a threshold the previous entry set. Raise a threshold by appending a new
entry once `bun run test:coverage && bun run coverage:check` already clears the new numbers
locally -- never by editing an existing entry.

### Known pre-existing test failures

As of 2026-09-04, `flutter test` on this branch has 11 pre-existing failures unrelated to ST-245
(none of them touch coverage-gate code):

- `test/features/shell/app_shell_golden_test.dart`, `test/features/student/presentation/timetable_screen_golden_test.dart`
  and `today_screen_golden_test.dart` (6 cases): golden pixel-diff mismatches. These goldens have
  never run in CI (no job invoked `flutter test` before this ticket) and this repro is from a
  Windows dev machine -- font/subpixel rendering differs enough from whatever platform the
  reference PNGs were captured on to produce a few percent pixel diff. Needs verifying against
  `mobile-unit-coverage`'s actual `ubuntu-latest` runner before deciding whether the goldens or the
  render is wrong.
- `test/core/router/auth_guard_boot_test.dart`, `test/widget_test.dart`: an authenticated/
  unauthenticated boot no longer lands where the test expects (`NavigationBar`/`"Studafy"` not
  found). Reproduces in isolation, not an ordering artifact.
- `test/features/ai/application/flashcard_controller_test.dart`,
  `test/features/ai/presentation/ai_usage_screen_test.dart`,
  `test/features/student/presentation/grades_screen_test.dart`: feature-level assertion failures,
  reproduce in isolation.

`mobile-unit-coverage` does not hide these: it still fails the job (the coverage gate and the
"any failing test" check are separate steps) so they stay visible, but the coverage report and its
artifact are produced regardless, since a failing test still exercises the lines it reaches before
it fails. Fixing them is tracked as separate follow-up work, not part of this ticket.

## Running locally

```sh
cd apps/mobile
flutter test                      # unit + widget suite
bun run test:coverage             # same, with coverage/lcov.info
bun run coverage:check            # gate + coverage/coverage-report.md
bun run test:integration          # API integration suite (needs a live API; see its own docs)
```
