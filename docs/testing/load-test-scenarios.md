# Load test scenarios (ST-248)

The load model, threshold rationale, and credential/fixture prerequisites behind the k6 suite in
[`infra/load-tests/`](../../infra/load-tests/). Read this before running the suite against anything
beyond a laptop — several of the sections below are gaps this ticket surfaced but did not close, and
running the suite against a real environment requires closing them first.

For exact commands, see [`infra/load-tests/README.md`](../../infra/load-tests/README.md). This doc
is the "why" and "how much"; that one is the "how".

## The three scenarios

### 1. Morning attendance peak

**Traffic shape:** closed model (fixed concurrent users), because this is bounded by "how many
teachers are on shift right now" — `ramping-vus`, ramp 0→`TEACHER_VUS` over 5 min, hold for 15 min,
ramp down over 3 min. Default `TEACHER_VUS=5000` — the ticket's own stated number, not an
assumption.

**Per-VU behavior:** one VU = one teacher for the run's lifetime. Each iteration: `POST
/api/attendance/sessions` (idempotent open) for one of the teacher's classes, then `POST
/api/attendance/records/batch` for that class's roster, chunked at the API's own hard cap of 50
records per call (`apps/api/src/modules/attendance/schemas.ts`). Sleeps 30–90s between iterations
(walking to the next class) rather than looping tightly — a teacher takes attendance a handful of
times in a 15-minute window, not continuously.

**Why not one giant school:** 5,000 concurrent teachers is a multi-school (district-scale) number —
`db/seeds/mock-credentials.ts`'s entire demo tenant has 3 teachers. The fixture generator
(`infra/load-tests/seed/generate-local-fixtures.ts`) makes this explicit by generating N synthetic
teachers, each with their own class and roster, rather than pretending one school has 5,000 teachers
on staff.

### 2. Results-day read storm

**Traffic shape:** open model (arrival rate), because a "read storm" is defined by requests per
second, not by how many people are staring at a spinner — `ramping-arrival-rate`, ramp 0→
`TARGET_RPS` over 2 min, hold 10 min, ramp down 1 min. Default `TARGET_RPS=200`.

**Endpoint:** `GET /api/grades/published/students/{studentId}/terms/{termId}`
(`apps/api/src/modules/grades/published/routes.ts`), deliberately Redis-cache-dominated
(`PUBLISHED_GRADES_CACHE_TTL_SECONDS = 3600` in `.../published/cache.ts`) — a real results-day storm
is mostly cache hits on a handful of just-published snapshots, which is exactly what this scenario's
tighter `p95Cached` threshold (300ms default) is measuring against.

**`TARGET_RPS=200` is an assumption, not a transcription of a stated target** — unlike scenario 1,
the ticket names this scenario without a number. As a sizing starting point: 200 req/s sustained for
10 minutes is 120,000 requests, which covers (say) a 20-school district of ~2,000 students each,
each checked twice (student + parent) within the window — a plausible district rollout, not a
single school. Rescale `TARGET_RPS` once real usage numbers exist.

### 3. AI ask concurrency

**Traffic shape:** closed model — `ramping-vus`, ramp 0→`AI_CONCURRENT_VUS` over 3 min, hold 10 min,
ramp down 1 min. Default `AI_CONCURRENT_VUS=300`, likewise an assumption (see the scenario file's
header comment for why AI concurrency is not modeled at scenario 1's scale: it is bounded by LLM
provider throughput and the per-school circuit breaker in `apps/api/src/modules/ai/llm/routing.ts`,
not by headcount).

**Endpoint:** `POST /api/ai/students/{studentId}/ask`, an SSE stream. k6's core `http` module has no
SSE parser; the scenario uses k6's own `http_req_waiting` (time to first byte) as a faithful proxy
for time-to-first-token and `http_req_duration` for time-to-fully-streamed-answer, which are exactly
the two numbers that matter here and avoids reaching for k6's experimental
websockets/streams modules for a per-token-latency number this suite doesn't need.

**Business outcomes vs. failures:** a 402/403/429 gate rejection (`apps/api/src/modules/ai/gate/`)
or a 200 response whose stream carries `event: refusal` (insufficient grounding,
`apps/api/src/modules/ai/ask/refusal.ts`) is the system behaving correctly under load, not a defect.
The scenario tracks a separate `ai_hard_failure_rate` custom metric that excludes both, so the
threshold that actually gates a load-test failure watches for real problems (5xx, network errors, a
stream that neither completed nor produced a documented terminal event) rather than conflating them
with expected quota/grounding enforcement.

## Threshold rationale (NFR-01 / NFR-02)

**Honesty note, stated plainly because it matters for how much weight to put on the numbers below:**
this repo has exactly one formalized NFR document —
[`docs/security/NFR-05_cross_tenant_isolation.md`](../security/NFR-05_cross_tenant_isolation.md).
NFR-01 and NFR-02 are referenced by this ticket's own title but no document for either exists
anywhere in this repo (checked `docs/`, `.sisyphus/`, `.opencode/`) — they live only in whatever
external tracker filed ST-248, which this suite's author does not have access to. The thresholds in
[`infra/load-tests/config/thresholds.js`](../../infra/load-tests/config/thresholds.js) are therefore
a **proposed default**, read as "NFR-01 = API latency budget" and "NFR-02 = error-rate/availability
budget", not a transcription of the real document:

| Path                               | Metric    | Default        | Rationale                                                                                                                                                                                                                     |
| ---------------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attendance open/batch (sync write) | p95 / p99 | 800ms / 1500ms | A full request that does real DB I/O under `withTenantTransaction`, scaled up from the ~0.3ms/~2ms budgets `JWT_verification_architecture.md` and the `apps/api/tests/benchmark` suites hold individual middleware layers to. |
| Published grades (cache hit path)  | p95       | 300ms          | Redis-GET-dominated; should be far tighter than a DB write.                                                                                                                                                                   |
| AI ask, time to first byte         | p95       | 3000ms         | Retrieval + grounded-prompt assembly before the model starts streaming — perceived responsiveness.                                                                                                                            |
| AI ask, full turn                  | p95       | 20000ms        | Provider-bound; a ceiling that catches a genuinely stuck stream, not a tight SLA.                                                                                                                                             |
| Any endpoint, error rate           | rate      | <1% (AI: <3%)  | AI gets a looser budget because a circuit-breaker 503 under provider degradation is the system working as designed, not this suite's concern.                                                                                 |

Every number is overridable by environment variable (`NFR01_P95_MS`, `NFR02_MAX_FAILED_RATE`, etc. —
see `config/thresholds.js`'s header) specifically so whoever holds the real NFR-01/02 document can
point this suite at the real targets without touching a script. **That env-var seam is the actual
"thresholds wired to NFR targets" this ticket asks for.** The values above are the fallback until
someone does that.

## Credentials and fixtures — the real gap

This is the section to read before assuming this suite can just be pointed at staging. Three
findings from building it, none fixed here because each is a decision outside this ticket's scope:

### 1. Staging has never actually run

Per `docs/runbooks/environment-matrix.md`'s own honesty note: nothing in `infra/terraform`/
`infra/deploy` has been applied against a real AWS account from this repo's authoring environment.
`staging-api.studafy.com` does not currently resolve to anything. This suite is written to run
against it once it exists, not proof that it currently does.

### 2. This suite cannot self-provision staging credentials — by design

Studafy has no password login; authentication is OIDC only (Google, Microsoft, or a `mock` provider
used by local dev and Playwright/Flutter E2E). The mock provider is hard-disabled the moment
`NODE_ENV` or `APP_ENV` is production-shaped
(`apps/api/src/modules/auth/oauth/mock-config.ts`'s `isMockOAuthSafeEnvironment`), and
`apps/api/src/env.ts:271-277` goes further: the API **refuses to boot at all** if
`MOCK_OAUTH_ISSUER_URL` is ever set alongside such an environment. Staging's own task definition
(`infra/deploy/ecs/api/task-definition.json.tpl:16`) hardcodes `NODE_ENV=production` for every
environment it deploys, staging included. This is a deliberate safety rail, confirmed intentional by
the code's own comments — not a gap for this suite to route around.

**Consequence:** `infra/load-tests/lib/auth.js`'s `AUTH_MODE=token-pool` (the default, and the only
mode staging can ever use) requires pre-minted, already-valid bearer tokens supplied via a data
file. Producing those requires either a real Microsoft/Google OIDC round trip per synthetic identity
(heavy — needs real test accounts in a real tenant) or a token-minting path this repo does not
currently have wired: `KeyStore.init()` (`apps/api/src/modules/auth/jwt/key-store.ts`) accepts an
optional `privateKeyPem` so a signing key _could_ be persisted and shared, but
`apps/api/src/index.ts:106` calls `keyStore.init()` with no arguments — every process, including
each of staging's two API replicas (`API_DESIRED_COUNT=2`), generates its own ephemeral key today.
That is finding 3, below, and it blocks token-minting either way.

### 3. No shared JWT signing key across replicas

`infra/deploy/ecs/api/task-definition.json.tpl`'s `secrets` array carries only database credentials
and `REDIS_URL` — no signing-key secret. Combined with finding 2's unwired `keyStore.init()`
argument, staging's two API tasks each mint tokens nobody else's process can verify: a token minted
against the replica an ALB happened to route a request to will 401 roughly half the time against the
other. This is a real correctness gap for staging generally, not specific to load testing — but it
means a load test run at scale would report a ~50% spurious auth failure rate that has nothing to do
with real capacity, which would be actively misleading to run before this is fixed. Fixing it (wiring
a persisted signing-key secret, the same way `PGBOUNCER_SECRET_ARN` is wired) is a prerequisite for
_any_ accurate multi-replica load test, not just this suite's — and belongs to whoever owns
`apps/api/src/index.ts`'s bootstrap and the ECS secrets wiring, not this ticket.

### 4. Nothing automatically seeds staging, on purpose

`db/seeds/guard.ts`'s `FORBIDDEN_HOST_PATTERNS` rejects any staging-shaped hostname outright, even
past its own `SEED_ALLOW_NONLOCAL` escape hatch, because "these are never a legitimate seed target."
`infra/load-tests/seed/generate-local-fixtures.ts` reuses that exact guard, unmodified — it is
**local-only** on purpose, useful only for proving the k6 suite mechanically correct. Provisioning
thousands of synthetic teacher/student identities in staging (once findings 1–3 above are resolved)
is therefore a deliberate, human-run, one-off action — the same posture
`infra/deploy/erpnext/seed`'s "seed tenant" already has (run explicitly via `--seed`, never
automatic) — not something any script, this one included, should do unattended.

**Bottom line:** this ticket delivers a complete, mechanically-verified k6 suite and the exact list
of what has to be true before it can run for real against staging. It does not — and structurally
should not, on this repo's own terms — provision that environment itself.

## Reports and regression comparison

`infra/load-tests/scripts/run.sh` archives every run to `reports/<scenario>/<UTC timestamp>/`
(`summary.json`, `metadata.json`, a rendered `report.md`) and diffs it against the most recently
archived run for the same scenario (`scripts/compare-regression.mjs`) — independent of the NFR
thresholds, because a run can be comfortably inside budget and still be a real regression against
last time (a p95 that crept from 200ms to 750ms against an 800ms threshold is exactly what a
threshold alone would never catch). A metric that regresses beyond tolerance
(`REGRESSION_LATENCY_TOLERANCE`, default +20% p95; `REGRESSION_RATE_TOLERANCE`, default +2
percentage points) fails the run unless `REGRESSION_STRICT=0`.

## What was verified vs. not

- **Verified for real:** all three k6 scripts were run (`k6 v2.2.0`, installed for this purpose)
  against a throwaway mock HTTP server standing in for the API — not just `k6 inspect`'s static
  parse, actual VU execution, request chunking, SSE-body outcome detection, and every threshold
  evaluating correctly. The `scripts/run.sh` → archive → regression-compare pipeline was run twice
  back-to-back and confirmed to (a) establish a baseline on the first run, (b) compare correctly
  against it on the second, and (c) correctly flag and non-zero-exit on an artificially regressed
  summary. Two real bugs surfaced only by doing this (an archive-before-compare ordering bug that
  made every regression check compare a run against itself, and a k6-summary-JSON shape mismatch
  that made every comparable metric silently disappear) were found and fixed this way — this suite
  would have shipped silently broken on both counts if it had only been reviewed statically.
- **Not verified:** the suite has never been run against a real Postgres/API stack (this authoring
  environment has no running Docker daemon), so `seed/generate-local-fixtures.ts`'s SQL — written
  against the exact column names `db/seeds/data/people.ts` and `db/seeds/data/academics.ts` use —
  has not executed for real. It has also, obviously, never run against staging, for the reasons
  above.

## Known gaps / follow-ups

1. A shared, persisted JWT signing key across API replicas (finding 3 above) — blocks accurate
   multi-replica load testing generally, not just this suite.
2. A real credential-provisioning path for staging load-test identities, once (1) is fixed — either
   a token-minting script with access to that shared key, or real OIDC test accounts.
3. The real NFR-01/NFR-02 numbers, to replace this doc's proposed defaults.
4. `TARGET_RPS` and `AI_CONCURRENT_VUS` are sizing assumptions, not measured targets — revisit once
   real usage telemetry exists.
5. This suite has not been run against a live Postgres or staging (see above) — do that before
   trusting it blind on a first real run.
