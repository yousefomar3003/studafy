# QA plan — security, API, and defect verification

Status: draft, 2026-11-02. Baseline commit: `fa3fe414` (`dev`).

## 1. How this plan was built, and what it is not

- **Static review, not a pentest.** Four parallel code reviews (auth/session, tenancy/authz,
  integrations/input handling, realtime/clients/infra), then every finding marked _Confirmed_ below
  was re-read against the source by a second reviewer. Nothing was exploited against a running
  system. "Confirmed" means "the code path does this"; the first job of each fix task is a failing
  test that proves it end-to-end.
- **Suspected** items are plausible but depend on something the code alone does not answer (deploy
  config, DB role attributes, product decisions). They get a verification task, not a fix task.
- **Not covered:** apps/mobile UI flows, the Flutter app beyond token storage/deep links, ERPNext
  internals, performance under real load, AWS account configuration outside `infra/terraform`.
- `graphify` is not installed on the review machine and `graphify-out/` was built from `91655a43`
  (July), so it was not used as a source of truth.

### Baseline (local, 2026-11-02)

| Suite                       | Pass | Skip | Fail | Note                                                                             |
| --------------------------- | ---- | ---- | ---- | -------------------------------------------------------------------------------- |
| `apps/api` (`bun test src`) | 1612 | 566  | 1    | Skips need Postgres/Redis. The fail is a stale local, gitignored `openapi.json`. |
| `apps/workers`              | 282  | 151  | 0    | Skips need Postgres/Redis.                                                       |
| `apps/realtime`             | 84   | 0    | 0    |                                                                                  |
| `apps/web`                  | 1061 | 0    | 0    |                                                                                  |

DB-backed suites (`tests/security`, `tests/auth`, cross-tenant, RLS coverage) were **not** run in
this pass: they need the test Postgres/Redis containers (QA-01).

### What already exists (and is good)

A real security suite (`apps/api/tests/security`, `tests/auth`), RLS coverage gate, cross-tenant
probe in CI, permission-guard coverage test, Semgrep, Trivy, oasdiff breaking-change check, axe
budget, critical-journey Playwright suite (nightly), load-test scenarios. The defects below are
mostly in places those gates structurally cannot see (body-value authorization, exempt-list
entries, cross-service contracts, non-API surfaces). The plan targets those blind spots rather than
re-testing what is already covered.

## 2. Findings register

Severity: **Critical** = cross-tenant or account takeover with low effort. **High** = privilege
escalation within a tenant, or a production feature that does not work. **Medium** = needs a
precondition or exposes secrets to insiders. **Low** = hardening / cost abuse.

### Confirmed

| ID   | Sev               | Finding                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                                                    |
| ---- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | Critical          | ORG_ADMIN can assign `SUPER_ADMIN` / `SUPPORT_AGENT` to any user in their school (including themselves). `roleSchema` accepts every role; `updateUserRole` writes it with no allowlist or rank check; no DB guard. After refresh the token carries `SUPER_ADMIN` → `/api/platform/*` runs as `studafy_admin` across all schools. Same schema backs create-user.                    | `apps/api/src/modules/users/schemas.ts:14,91,162`, `users/routes/user-routes.ts:331,438`, `users/user-service.ts:383-412`, `packages/constants/src/permissions.ts:290`                      |
| F-02 | Critical          | Unclaimed member accounts can be taken over with a global default password. Accounts with no stored hash accept `pass@1234` and let the caller set a new password and get a session. Usernames are sequential (`STU-100001`). Admin password reset reopens the window. Only per-IP rate limit applies.                                                                             | `apps/api/src/modules/auth/services/member-password-service.ts:36,121-123,310-315`, `db/migrations/000140_add_member_codes.sql`                                                             |
| F-03 | High              | `POST /api/schools/{schoolId}/provision` has no permission check and no `schoolId === auth.schoolId` check; it inserts `ORG_ADMIN` for the caller. Any authenticated user of a school whose provisioning is not `completed`/`in_progress` becomes ORG_ADMIN. Route is on the guard-coverage exempt list.                                                                           | `apps/api/src/modules/tenancy/provisioning/route.ts:81,98-145`, `provisioning/service.ts:85-109,264-271`, `apps/api/tests/permission-guard-coverage.test.ts:71,584`                         |
| F-04 | High              | Realtime room join only checks `schoolId`. Any socket can join `school:<own>:user:<anyId>` or `school:<own>:role:admin` and receive that user's/role's events.                                                                                                                                                                                                                     | `apps/realtime/src/app.ts:240-248`                                                                                                                                                          |
| F-05 | High (functional) | Web→realtime handshake cannot work in deployed envs: web sends the API's RS256 session token as `?token=`, gateway verifies HS256 against a separate Terraform random secret. Also: `WS_JWT_SECRET` defaults to `dev-insecure-secret-change-me` with no prod guard; revocation never re-checked mid-connection; token without `exp` never expires; token in URL lands in ALB logs. | `apps/web/src/lib/realtime/client.ts:95-98`, `apps/realtime/src/auth.ts:73-77`, `apps/realtime/src/env.ts:43`, `apps/api/src/middleware/jwtAuth.ts:19`, `infra/terraform/main.tf:153`       |
| F-06 | High (functional) | Production RAG uses a hash-based pseudo-embedder for both ingestion and query. The vector half of hybrid search is semantically meaningless while `AI_LLM_ENABLED=true` in prod. Documented as intentional; still a product-quality defect.                                                                                                                                        | `apps/api/src/modules/ai/retrieval/embeddings.ts:72`, `apps/api/src/app.ts:1326,1353`, `apps/workers/src/queues/ai-ingestion/worker.ts:181`                                                 |
| F-07 | Medium            | OAuth `state` is not bound to the browser (Redis-only). Login CSRF: attacker sends victim their own callback URL; victim is signed into attacker's account.                                                                                                                                                                                                                        | `apps/api/src/modules/auth/oauth/google-route.ts:96,181`, `microsoft-route.ts:91,176`, `callback-flows.ts:48-56`                                                                            |
| F-08 | Medium            | Refresh-token reuse detection revokes the family in Postgres but never denylists its `access_jti`; the attacker's access token stays valid up to 15 min. Contradicts `docs/security/device_revocation_and_logout.md`.                                                                                                                                                              | `apps/api/src/modules/auth/services/session-service.ts:492-533`                                                                                                                             |
| F-09 | Medium            | Request logger writes the full query string unredacted: OAuth `code`/`state`, Google Play RTDN `?token=` shared secret. Path redaction misses `/api/auth/invitations/{token}/activate` and `/api/schools/verify-email/{token}`. Anyone with CloudWatch read can verify a school email or replay the RTDN secret.                                                                   | `apps/api/src/middleware/logger.ts:48`, `apps/api/src/lib/security/sensitive-path.ts`, `modules/subscriptions/store/routes.ts:131,218`                                                      |
| F-10 | Medium            | Web app served with no CSP/HSTS/XFO/nosniff from CloudFront (header policies set only `Cache-Control`). Container nginx loses server-level headers in `location = /index.html` (`add_header` inheritance).                                                                                                                                                                         | `infra/terraform/modules/cdn/distribution.tf:87-148`, `infra/docker/web/nginx.conf:24-39`                                                                                                   |
| F-11 | Medium            | CSV formula injection in audit-log export (user-agent is attacker-controlled) and finance-reporting export. Custom lists and web already have the guard.                                                                                                                                                                                                                           | `packages/audit-reporting/src/index.ts:324-346`, `packages/finance-reporting/src/index.ts:112-116`                                                                                          |
| F-12 | Medium            | SNS signature uses the Notification field list for every type. Real `SubscriptionConfirmation` messages (signed over `SubscribeURL`, `Token`) can never verify, so auto-confirm is dead; tests share the bug. `SubscribeURL` is fetched with no host allowlist.                                                                                                                    | `apps/api/src/email/sns-signature.ts:59`, `apps/api/src/email/webhook.ts:232-240`                                                                                                           |
| F-13 | Medium            | Idempotency key is global (`idem:<key>`): not scoped to school/user/method/path. Same key + same body from another user/tenant replays the stored response. In-flight lock is a per-process Map, so two instances can both execute.                                                                                                                                                | `apps/api/src/middleware/idempotency.ts:90-91,156-187`                                                                                                                                      |
| F-14 | Medium            | Only study materials go through ClamAV. Submission, assignment, expense, message, record and staff-document attachments are served without any scan.                                                                                                                                                                                                                               | `apps/api/src/modules/storage/download-service.ts:57-70`                                                                                                                                    |
| F-15 | Medium            | Three sign-in routes store raw `X-Forwarded-For` (possibly multi-hop) into `inet` columns → 500 on sign-in for users behind a proxy that sets XFF. Two other routes take the client-controlled first hop for session/audit IPs.                                                                                                                                                    | `apps/api/src/modules/auth/routes/member-password-routes.ts:153`, `review-login-routes.ts:105`, `returning-user-login-routes.ts:200`, `session-routes.ts:617`, `admin-device-routes.ts:267` |
| F-16 | Medium            | Realtime has no `maxPayloadLength`, no per-socket room cap, no message rate limit, no Origin check. One token can grow room maps until OOM.                                                                                                                                                                                                                                        | `apps/realtime/src/app.ts:214-253`, `apps/realtime/src/index.ts:83`, `rooms.ts:56-70`                                                                                                       |
| F-17 | Medium            | Provisioning-status read and several provisioning/price-sync/bulk-invite queries use the raw pool outside any tenant tx, with no ownership check. Impact depends on S-01.                                                                                                                                                                                                          | `tenancy/provisioning/route.ts:83-86`, `provisioning/service.ts:156-182,400-410`, `price-sync-service.ts:46,88`, `apps/workers/.../bulk-invite-processor.ts:57-111`                         |
| F-18 | Medium            | Third-party GitHub Actions pinned by mutable tag in jobs holding credentials / `id-token: write` (`configure-aws-credentials@v4`, `cosign-installer@v3`, `docker/login-action@v3`, `trivy-action@v0.36.0` in containers/terraform).                                                                                                                                                | `.github/workflows/{containers,deploy,release,terraform,build-and-sign}.yml`                                                                                                                |
| F-19 | Low               | Presigned upload PUT does not bind size; objects up to 5 GB can land in the temp prefix (24h cleanup).                                                                                                                                                                                                                                                                             | `apps/api/src/modules/storage/service.ts:66`                                                                                                                                                |
| F-20 | Low               | CSV import reads the whole body (up to Bun's 128 MB) and parses inside a tenant tx; row cap applies after parsing.                                                                                                                                                                                                                                                                 | `apps/api/src/modules/imports/routes/import-routes.ts:669-683`                                                                                                                              |

### Suspected (needs verification, not a fix yet)

| ID   | Question to answer                                                                                                          | Why it matters                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S-01 | Does the runtime DB login (RDS master via PgBouncer) have `BYPASSRLS` / `rds_superuser` effect?                             | If yes, every raw-pool query (F-17) is a cross-tenant read and RLS depends entirely on every path calling `set_config('role', …)`. |
| S-02 | Is `REDIS_URL` actually set in staging/prod? `env.ts:127` makes it optional outside dev.                                    | Without it: no access-token denylist, no rate limiting, in-memory OAuth state.                                                     |
| S-03 | Microsoft login uses `preferred_username ?? email` and does not check issuer tenant vs `tid` (`microsoft-id-token.ts:108`). | nOAuth-style email spoofing against invitation email matching.                                                                     |
| S-04 | Do school staff ever get ERPNext desk / Webhook-doctype write access?                                                       | One global webhook secret + `school_id` from payload → forged finance events for another school.                                   |
| S-05 | Is there a public TestFlight / Play tester track? Sandbox purchases are accepted in prod.                                   | Free AI add-on entitlement.                                                                                                        |
| S-06 | Are outbox payloads holding raw invitation/verification/deletion tokens purged after send?                                  | Live tokens at rest in DB.                                                                                                         |
| S-07 | Can push delivery double-send on retry/stall? No `enqueued` status re-check before `push.send`.                             | Duplicate notifications to every device.                                                                                           |
| S-08 | Does global search (`search_scoped_ids`, SECURITY DEFINER) leak hidden rows via counts/ranking/timing?                      | Intra-tenant role-scope leak.                                                                                                      |
| S-09 | Does the FINANCE audience projection for records (read as `studafy_admin`) strip all non-finance fields?                    | Intra-tenant over-exposure.                                                                                                        |
| S-10 | SNS events: is there `MessageId` dedup? Captured bounce/complaint envelopes may be replayable.                              | Suppression-list poisoning.                                                                                                        |
| S-11 | Mobile has no certificate pinning; OAuth deep link is a custom scheme (PKCE present).                                       | Product decision, record it explicitly.                                                                                            |

## 3. Tasks

Conventions: every fix task starts by adding a **failing** test that reproduces the finding, then
the fix, then the test passes in CI. "Done" means merged to `dev` with CI green — not "PR opened".

### Phase 0 — Environment

**QA-01 — Runnable DB-backed test environment**

- Depends on: —
- Do: bring up `test-postgres`/`test-redis` (`bun run db:up`, ports 54330/…) and run
  `bun run test:security`, `bun --cwd apps/api run test:auth`, `test:cross-tenant`,
  `db:test:rls-coverage`, `apps/workers` DB tests. Record results in this file's baseline table.
- Acceptance:
  - All DB-backed suites run locally with 0 unexpected skips.
  - Any failure is either fixed or filed with an owner; the baseline table is updated.
  - Does not touch ports used by other local projects (5173, 5432).

**QA-02 — Staging test accounts and tooling**

- Depends on: —
- Do: one review tenant in staging with a user per role (SUPER_ADMIN in platform tenant, ORG_ADMIN,
  PRINCIPAL, INSTRUCTOR, STUDENT, PARENT, FINANCE, ATTENDANCE_OFFICER) in **two** schools. Postman/Bruno
  or `curl` collection checked into `infra/load-tests` or a new `qa/` folder.
- Acceptance: a tester can obtain a bearer token for every role in both schools in < 5 minutes
  without DB access.

### Phase 1 — Reproduce and fix Critical/High (release blockers)

**QA-10 — F-01 role escalation to SUPER_ADMIN**

- Depends on: QA-01
- Acceptance:
  - New test: ORG_ADMIN `PUT /api/users/{id}/role {"role":"SUPER_ADMIN"}` and `{"role":"SUPPORT_AGENT"}`
    and create-user with those roles → `400`/`403`; `user_roles` unchanged.
  - New test: a non-platform-tenant user can never hold a platform role at the DB layer (CHECK or
    trigger), even when written directly as `studafy_app`.
  - New test: caller cannot grant a role above their own (ORG_ADMIN cannot create another
    ORG_ADMIN unless that is an intended product rule — decide and document in the permission matrix).
  - Audit of every other endpoint taking a role in the body (`schemas.ts:55,263`, invitations, imports).

**QA-11 — F-02 default-password account claim**

- Depends on: QA-01
- Acceptance:
  - No account can be activated with a value an attacker can know or guess. Initial credential is
    per-member, random (≥ 64 bits), single-use, expires (e.g. 14 days), and is shown/printed only to
    the admin who issued it.
  - Admin reset issues a new one-time secret instead of restoring a global default.
  - Per-username and global rate limits on member login, independent of IP.
  - `member-password-login.test.ts` updated: the old "default password works" case now asserts failure.
  - Migration/rollout plan for already-issued accounts that have never signed in.

**QA-12 — F-03 provision route self-promotion**

- Depends on: QA-01
- Acceptance:
  - Route requires `ORGANIZATION_MANAGE_SETTINGS` (or platform permission) **and** `schoolId === auth.schoolId`.
  - Removed from `GUARD_EXEMPT_ROUTES`.
  - Tests: STUDENT/INSTRUCTOR → 403; ORG_ADMIN of school A on school B → 403/404; no `user_roles`
    write and no `provisioning_status` change in either case.

**QA-13 — F-04 / F-16 realtime room authorization and limits**

- Depends on: —
- Acceptance:
  - Test: socket for user U cannot join `school:S:user:V` (V ≠ U) or `school:S:role:R` (R ∉ U's roles).
  - Per-kind policy table in `apps/realtime` with a test per room kind; unknown kinds rejected.
  - `maxPayloadLength` ≤ 16 KB, ≤ N rooms per socket, control-frame rate limit, Origin allowlist —
    each with a test.

**QA-14 — F-05 realtime handshake contract**

- Depends on: QA-02
- Do first: confirm in staging that the web app's socket gets 401 today (one browser session, check
  gateway logs). Record the result here.
- Acceptance:
  - API mints a short-lived (≤ 60 s), audience-scoped realtime ticket; gateway verifies it with the
    API's JWKS (or an agreed key) — one documented contract.
  - Ticket is not the session token; gateway does not log it; ALB access log check shows no session token in URLs.
  - Gateway refuses to boot in production with the default secret (env test).
  - Revocation: a revoked session's socket is closed within a bounded time (state the bound, test it).
  - Contract test that runs the real API token issuer against the real gateway verifier.

**QA-15 — F-06 production embeddings decision**

- Depends on: —
- Acceptance (product + engineering decision, recorded in an ADR):
  - Either a real embedding provider is wired (ingestion + query, same model id, re-embed procedure
    run), or vector search is disabled in prod and retrieval is lexical-only, with the UI/marketing
    copy matching.
  - `tests/ai-eval` golden set run against the chosen configuration; groundedness/recall numbers
    recorded against `docs/security/NFR-11_rag_groundedness.md` targets.

**QA-16 — S-01 database role verification**

- Depends on: —
- Acceptance:
  - Documented output of `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles` and role memberships
    for the PgBouncer login in staging and prod.
  - If the login can bypass RLS: ticket to introduce a least-privilege login role, and F-17 raised to High.
  - Lint/test forbidding direct `database\`` use in `apps/api/src/modules/**` outside an allowlist.

### Phase 2 — Medium security fixes

Each task: failing test first, fix, test green. Acceptance criteria are the test cases.

| Task  | Finding                       | Depends on | Acceptance                                                                                                                                                                                                                                                                                                            |
| ----- | ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-20 | F-07 OAuth login CSRF         | QA-01      | Callback with valid `state` but missing/mismatched browser-binding cookie → rejected, no refresh cookie set. Same for Google, Microsoft, mock, school-applications OAuth.                                                                                                                                             |
| QA-21 | F-08 reuse → denylist         | QA-01      | After reuse detection, the family's current access token gets `401` on a protected route within one request.                                                                                                                                                                                                          |
| QA-22 | F-09 secrets in logs          | —          | Logger test: `code`, `state`, `token`, `password`, `secret` query keys are `[REDACTED]`; `sensitive-path` test covers `/invitations/{t}/activate` and `/schools/verify-email/{t}`. Rotate the Google Play RTDN token after deploy. CloudWatch Insights query over 30 days of logs for leaked values, result recorded. |
| QA-23 | F-10 web security headers     | —          | `curl -I` against staging web root and a deep SPA route shows CSP (no `unsafe-inline` for scripts), HSTS, `X-Frame-Options`/`frame-ancestors`, `nosniff`, `Referrer-Policy`. CI check on nginx config. CSP tested against the real app for violations (report-only for one week first).                               |
| QA-24 | F-11 CSV injection            | —          | One shared `csvCell` helper; audit and finance exports prefix `= + - @ \t \r` cells; unit tests per export.                                                                                                                                                                                                           |
| QA-25 | F-12 SNS signature            | —          | Tests use **real AWS-signed fixtures** for Notification and SubscriptionConfirmation (not self-signed with the code's own canonicaliser). `SubscribeURL` host pinned to `sns.<region>.amazonaws.com`.                                                                                                                 |
| QA-26 | F-13 idempotency scope        | QA-01      | Same key, same body, different user/school/path → handler executes, no replay. Two-instance concurrent test (or Redis `SET NX` unit test) → handler runs once.                                                                                                                                                        |
| QA-27 | F-14 attachment scanning      | QA-01      | Every user-uploaded class is scanned; download of unscanned/infected object → 409/404; EICAR test file per class in an integration test; ClamAV down → fail closed (asserted).                                                                                                                                        |
| QA-28 | F-15 X-Forwarded-For          | QA-01      | Sign-in, refresh, device routes with `XFF: "1.2.3.4, 5.6.7.8"` and `XFF: "garbage"` → 200 and stored IP is the last trusted hop or `NULL`; never 500. All routes use `extractClientIp`.                                                                                                                               |
| QA-29 | F-17 raw-pool queries         | QA-16      | Every listed query runs inside `withTenantTx`/`withSystemTx`; `GET …/provisioning-status` for another school → 403/404.                                                                                                                                                                                               |
| QA-30 | F-18 action pinning           | —          | Every third-party `uses:` is a 40-char SHA with a version comment; CI check (e.g. `zizmor` or a grep step) fails on tag pins.                                                                                                                                                                                         |
| QA-31 | F-19, F-20 upload/body limits | —          | Presigned POST with `content-length-range` (or signed `ContentLength`); oversized PUT rejected by S3 in a test against MinIO. Import route has `bodyLimit`; > limit → 413 before any DB connection is taken.                                                                                                          |

### Phase 3 — Verify suspected items

| Task  | Item                   | Depends on | Acceptance                                                                                                                                                                                                 |
| ----- | ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-40 | S-02 Redis required    | —          | Prod/staging task definitions checked; `env.ts` refuses to boot without `REDIS_URL` when `APP_ENV ≠ development`, with test.                                                                               |
| QA-41 | S-03 Microsoft claims  | QA-01      | Activation email match uses only a verified claim; issuer tenant must equal `tid`. Tests with crafted id_tokens.                                                                                           |
| QA-42 | S-04 ERPNext secret    | —          | Written answer from ops on desk access. If any staff access exists: per-site secret or Host→school mapping, plus test that a payload naming another `school_id` is refused.                                |
| QA-43 | S-05 sandbox purchases | —          | Product decision recorded. If restricted: sandbox accepted only for allowlisted review accounts, tested.                                                                                                   |
| QA-44 | S-06, S-07, S-10       | QA-01      | Outbox token purge confirmed or implemented; push worker re-checks status before send (duplicate-job test); SNS `MessageId` dedup confirmed or implemented.                                                |
| QA-45 | S-08, S-09             | QA-01      | Search: a hidden row does not change result count, page boundaries, or p95 latency measurably (test with/without hidden rows). Records: FINANCE projection snapshot test lists exactly the allowed fields. |
| QA-46 | S-11 mobile pinning    | —          | Decision recorded in `docs/security`; if pinning is adopted, a test build fails against a MITM proxy.                                                                                                      |

### Phase 4 — Close the test-design blind spots (so these classes do not recur)

**QA-50 — Body-value authorization tests**

- Depends on: QA-10
- Acceptance: for every request schema field that names a role, permission, `school_id`, `user_id`,
  `audience`, or price/amount, a test that sends a value the caller must not set and expects 4xx.
  Field list generated from `openapi.json` and checked in, so new fields fail CI until classified.

**QA-51 — Guard-coverage test hardening**

- Depends on: QA-12
- Acceptance: coverage test checks guards per route (method + path), not "file contains
  `requirePermission(`"; covers GET routes; each exempt entry needs a linked test proving the route's
  own check. Every current exemption re-reviewed and signed off in the PR.

**QA-52 — API fuzzing from the OpenAPI spec**

- Depends on: QA-01, QA-02
- Acceptance: Schemathesis (or equivalent) runs against a local API with a token per role; nightly
  job; zero `5xx` and zero schema-violating responses on the stateless checks; findings triaged
  into tickets. Start report-only, make blocking once the backlog is clear.

**QA-53 — Cross-role IDOR matrix**

- Depends on: QA-02
- Acceptance: for every `{id}` route: owner → 2xx; same-school other role without scope → 403/404;
  other school any role → 404. Generated from the spec, run against the two-school fixture. Extends
  `cross-tenant.test.ts` from tenant-level to role/ownership-level (parent↔other child,
  teacher↔untaught class, student↔other student).

**QA-54 — DAST baseline**

- Depends on: QA-02, QA-23
- Acceptance: OWASP ZAP baseline + authenticated API scan against staging, weekly; High alerts
  block release; report archived per run.

**QA-55 — Cross-service contract tests**

- Depends on: QA-14
- Acceptance: contract tests for web↔realtime token, API↔workers job payloads, API↔ERPNext webhook
  shape, SNS/Stripe/Tap/Apple/Google fixtures captured from real providers (sandbox), not generated
  by our own code.

**QA-56 — Extend SQL-interpolation lint**

- Depends on: —
- Acceptance: `eslint.config.js` rule applied to `apps/workers/src` and `packages/*/src`;
  `interpolated-sql-lint.test.ts` seeds a violation in each.

### Phase 5 — API functional and non-functional

**QA-60 — API contract conformance**

- Depends on: QA-01
- Acceptance: every documented response code per operation (568 operations) has at least one test,
  or is listed as untested in a generated report; RFC 7807 problem shape asserted for all 4xx/5xx;
  pagination (keyset cursors) tested for stability under concurrent inserts.

**QA-61 — Critical journeys in CI**

- Depends on: QA-02
- Acceptance: `e2e-critical` passes 5 nightly runs in a row (flake rate measured and recorded);
  mobile-only journeys (teacher/student/parent) have API-level equivalents if no device E2E exists.

**QA-62 — Load and resilience**

- Depends on: QA-01
- Acceptance: `infra/load-tests` scenarios run against staging-sized infra; p95 targets from
  `docs/testing/load-test-scenarios.md` met or a gap ticket filed. Fault injection: Redis down,
  ClamAV down, ERPNext down, LLM provider down — each produces the documented behaviour (fail
  closed vs open) and no 5xx storms; results tabulated.

**QA-63 — Time zone / locale / RTL**

- Depends on: —
- Acceptance: `docs/testing/timezone-test-catalog.md` cases all mapped to an existing test or a new
  one; Arabic RTL screenshots reviewed for the admin portal's top 10 screens.

### Phase 6 — CI gates

**QA-70 — Make security gates blocking**

- Depends on: QA-30, QA-52, QA-56
- Acceptance:
  - Secret scanning on full git history (gitleaks or trufflehog) as a required check.
  - `dependency-review` either enabled in repo settings and blocking, or removed (no silent `continue-on-error`).
  - Semgrep full-scan backlog triaged to zero High, then baseline mode kept.
  - Flutter analyze/tests stop being `continue-on-error` once their backlog is zero.
  - Branch protection on `main` and `dev` lists every required job by name.

## 4. Dependency overview

```
QA-01 ─┬─ QA-10 ── QA-50
       ├─ QA-11
       ├─ QA-12 ── QA-51
       ├─ QA-20, QA-21, QA-26, QA-27, QA-28, QA-41, QA-44, QA-45, QA-60, QA-62
       └─ QA-52 ─┐
QA-02 ─┬─ QA-14 ── QA-55
       ├─ QA-52 ─┴─ QA-70 ── (also QA-30, QA-56)
       ├─ QA-53, QA-61
       └─ QA-54 (also QA-23)
QA-16 ── QA-29
Independent: QA-13, QA-15, QA-22, QA-23, QA-24, QA-25, QA-30, QA-31, QA-40, QA-42, QA-43, QA-46, QA-56, QA-63
```

## 5. Release exit criteria

A production release is blocked until:

1. QA-10, QA-11, QA-12, QA-13 are done (F-01–F-04 fixed with regression tests).
2. QA-14 and QA-15 are done, or the realtime/AI features are explicitly disabled in prod with the
   decision recorded.
3. QA-16 answered; if the DB login bypasses RLS, QA-29 is done.
4. QA-22 done and the RTDN secret rotated.
5. No open Critical/High from QA-52/QA-54 scans.
6. All DB-backed security suites green in CI on the release commit.
