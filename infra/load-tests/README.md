# Load tests (ST-248)

k6 scenarios for the three traffic shapes this ticket names: a morning attendance-taking peak, a
results-day read storm, and sustained Ask AI concurrency. Thresholds are wired to NFR-01/02 (see the
honesty note in `config/thresholds.js` — no authoritative NFR-01/02 document exists anywhere in this
repo; the numbers there are a documented proposed default, overridable by environment variable).
The full load model, threshold rationale, and — most importantly — the prerequisites this ticket
surfaced but does not close, live in
[`docs/testing/load-test-scenarios.md`](../../docs/testing/load-test-scenarios.md). Read that before
running anything against a real environment.

## Layout

```
infra/load-tests/
├── config/          environment + NFR-01/02 threshold resolution (env-var overridable)
├── lib/             shared k6 helpers: auth (token-pool | mock-oauth), request tagging
├── scenarios/       the three k6 scripts — one file each, runnable standalone with `k6 run`
├── seed/            LOCAL-ONLY fixture generator (never touches staging — see below)
├── data/            data files the scenarios read; example-*.json are committed samples
├── scripts/         run.sh (orchestrates one scenario + comparison + archiving), regression
│                    comparison, report archiving
└── reports/         archived run artifacts (gitignored; see scripts/archive-report.mjs)
```

## Quickstart — local

This is the only path proven end-to-end by this ticket (no live staging exists to run the other
path against — see "Honesty: what was and wasn't run" below). It needs a local API with the mock
OAuth provider enabled:

```bash
# 1. Local stack up, migrated, demo tenant seeded (see repo root README / db/seeds/README.md)
bun run db:up && bun run db:migrate && bun run db:seed

# 2. Enable the mock IdP for local dev (apps/api/src/modules/auth/oauth/mock-config.ts) and start
#    the API — e.g. in apps/api/.env or your shell:
#      MOCK_OAUTH_ISSUER_URL=http://localhost:3000/mock-idp
#      MOCK_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/oauth/mock/callback
bun run --cwd apps/api dev

# 3. Generate load-test-scale fixtures on top of the demo tenant (adds N synthetic teachers/
#    classes/students; defaults are small — this is for proving the suite works, not for load)
cd infra/load-tests
TEACHER_COUNT=20 STUDENTS_PER_CLASS=25 bun seed/generate-local-fixtures.ts

# 4. Run a scenario. AUTH_MODE=mock-oauth logs each synthetic identity in through the real
#    /api/auth/oauth/mock/* route (see lib/auth.js) — the generated data files have no
#    pre-minted token, only an email.
AUTH_MODE=mock-oauth TEACHERS_FILE=./data/teachers.json TEACHER_VUS=20 \
  RAMP_UP=10s HOLD=30s RAMP_DOWN=10s \
  bash scripts/run.sh morning-attendance-peak
```

Scale the numbers down for a laptop — `TEACHER_VUS=20`, short stages — this is a smoke test of the
mechanics, not the actual 5,000-teacher load model (see the load model doc for that math).

## Running against a real environment

```bash
TARGET_ENV=staging \
  TEACHERS_FILE=/path/to/real/teachers.json \
  bash scripts/run.sh morning-attendance-peak
```

`AUTH_MODE=mock-oauth` **cannot** be used here — `MOCK_OAUTH_ISSUER_URL` is refused at boot whenever
`NODE_ENV`/`APP_ENV` is production-shaped (`apps/api/src/env.ts:271-277`), and staging's own task
definition hardcodes `NODE_ENV=production`
(`infra/deploy/ecs/api/task-definition.json.tpl:16`) — this is a deliberate safety rail, not a gap
to route around. `TEACHERS_FILE`/`STUDENTS_FILE`/`AI_STUDENTS_FILE` must instead point at a data
file with real, already-valid `accessToken`s (`AUTH_MODE=token-pool`, the default). See the load
model doc's "Credentials and fixtures" section for exactly what has to exist before that file can be
produced for real — it is a real gap, not a formality.

## Configuration

Every scenario reads its own subset of these; see each scenario file's header for the full list.

| Variable                                               | Default                    | Meaning                                                                                              |
| ------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `TARGET_ENV`                                           | `local`                    | Selects a base URL from `config/environments.js`.                                                    |
| `BASE_URL`                                             | —                          | Overrides `TARGET_ENV` outright.                                                                     |
| `AUTH_MODE`                                            | `token-pool`               | `token-pool` (reads pre-minted tokens) or `mock-oauth` (local/dev only).                             |
| `TEACHERS_FILE` / `STUDENTS_FILE` / `AI_STUDENTS_FILE` | `data/example-*.json`      | Identity data per scenario.                                                                          |
| `TEACHER_VUS`                                          | `5000`                     | Scenario 1's concurrent-teacher target (the ticket's literal number).                                |
| `TARGET_RPS`                                           | `200`                      | Scenario 2's peak arrival rate — a sizing assumption, not a measured target; see the load model doc. |
| `AI_CONCURRENT_VUS`                                    | `300`                      | Scenario 3's concurrent-asker target — likewise an assumption.                                       |
| `NFR01_*_MS`, `NFR02_*`                                | see `config/thresholds.js` | The proposed NFR-01/02 numbers. Override once the real document exists.                              |
| `REGRESSION_STRICT`                                    | `1`                        | Set `0` to only warn on a regression against the last archived run instead of failing the run.       |

## Reports and regression comparison

`scripts/run.sh` always archives the run's summary to `reports/<scenario>/<UTC timestamp>/`
(`summary.json` + `metadata.json` + a rendered `report.md`) and compares it against the
most-recently-archived run for that scenario (`scripts/compare-regression.mjs`), independent of
whether the NFR thresholds themselves passed — a run can be comfortably inside budget and still be a
real regression against last time. Calling `k6 run` directly skips both steps; always go through
`scripts/run.sh`.

## Why this is not wired into CI

There is no k6 binary in this repo's CI image and no reachable staging to point it at (see the
honesty note in `docs/runbooks/environment-matrix.md` — staging has never been applied against a
real AWS account from this repo's own authoring environment). This suite is an operator-run tool for
pre-term load validation, the same posture `infra/deploy/scripts/deploy.sh` and
`erpnext-new-site.sh` already have — written to work, not proven against a live account by CI.

## Honesty: what was and wasn't run

- The k6 scripts were reviewed against the k6 v0.5x API but **not executed against a real k6
  binary** — this authoring environment has neither `k6` nor a running Docker daemon available.
  `k6 inspect` (which only parses `options`/`exports`, no network needed) is the cheapest way to
  validate them before a real run; do that first.
- `seed/generate-local-fixtures.ts` was written against the exact schema and column names
  `db/seeds/data/people.ts` and `db/seeds/data/academics.ts` use, but was not run against a live
  Postgres from this authoring environment either (no local Postgres running here). Run it against a
  real local stack before trusting it blind.
