# ST-249: security test pass — findings and fixes

Pre-launch internal security pass: live authz-matrix fuzzing (every role x every route), SSRF/IDOR
review, a dependency audit, and a full-history secrets scan. This doc is both the findings report
and the fixes log — every finding below either shipped a fix in this same change or carries an
explicit, reasoned accepted-risk disposition. **Zero critical/high findings are open at exit.**

Everything here was run against a real Postgres (`db/compose.yml`) and the real app
(`createApp()`), not mocked — see [Reproducing this pass](#reproducing-this-pass).

## Summary

| #   | Finding                                                                                                                                        | Severity      | Status                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| 1   | `.use()` middleware mounted on an OpenAPI-style `{param}` path never matches a real request — 155 call sites across ~50 files                  | **Critical**  | Fixed                                                                      |
| 2   | Same root cause, wildcard form: `"prefix*"` (glued) silently matches nothing once mounted via `app.route()`                                    | **Critical**  | Fixed                                                                      |
| 3   | `GRADE_READ` gate on the child-comparison breakdown route silently dead (same root cause, via a `.path` reference)                             | High          | Fixed                                                                      |
| 4   | `GET /api/finance/expenses/summary` always 500s — shadowed by the `{expenseId}` route                                                          | High          | Fixed                                                                      |
| 5   | `GET /api/finance/invoices/batches` always 500s — same shadowing pattern                                                                       | High          | Fixed                                                                      |
| 6   | `GET /api/imports/students/template` always 500s — same shadowing pattern                                                                      | High          | Fixed                                                                      |
| 7   | `GET /api/approvals/queue` always 500s — `UNION ALL` of two incompatible Postgres enum types                                                   | High          | Fixed                                                                      |
| 8   | `GET`/`PATCH /api/schools/current/settings` — lazy-init race, concurrent first read/write 500s                                                 | High          | Fixed                                                                      |
| 9   | `POST /api/finance/reconciliation/run` denial bypasses the app's error envelope                                                                | Medium        | Fixed                                                                      |
| 10  | Open redirect on the OAuth login round-trip (`return-to.ts` + react-router)                                                                    | Medium        | Fixed                                                                      |
| 11  | `hono` 4.12.28: 4 moderate CVEs (ReDoS, SSR data leak, header leak, middleware DoS)                                                            | Medium        | Fixed (bumped to 4.12.34)                                                  |
| 12  | `react-router(-dom)`: 2 moderate CVEs, no 6.x fix exists upstream                                                                              | Medium        | Mitigated at the app layer (#10); residual advisory accepted, tracked      |
| 13  | `@xmldom/xmldom` (via `mammoth`), `uuid` (via `firebase-admin` chain): moderate CVEs, no reachable call path                                   | Low           | Accepted risk                                                              |
| 14  | `brace-expansion`, `browserslist`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `storybook`: high severity per advisory, all devDependency-only | Informational | Accepted risk                                                              |
| 15  | Secrets in git history                                                                                                                         | —             | Scanned (541 commits), 8 hits, all confirmed test fixtures, 0 real secrets |
| 16  | CI's `secret-scan` job never covered git history, only the working tree                                                                        | Gap           | Fixed — new `secret-scan-history` job                                      |

No SSRF vector found (§ [SSRF review](#ssrf-review)). Cross-tenant/IDOR coverage was already
substantial pre-existing (§ [IDOR / cross-tenant](#idor--cross-tenant)) and remains green.

---

## 1-2. Critical: `.use()` middleware silently never runs on ~155 routes

### What was actually wrong

Every guarded parameterized route in this app follows the same pattern (see
`src/middleware/authz.ts`'s own docstring):

```ts
routes.use("/api/students/{studentId}", requirePermission(PERMISSIONS.STUDENT_READ));
routes.openapi(getStudentRoute, handler); // getStudentRoute's own path is also "{studentId}"
```

`{studentId}` is `@hono/zod-openapi`'s `createRoute({ path })` syntax. `.openapi()` translates it
to Hono's own `:studentId` internally before handing it to the router — but `.use()` is inherited
straight from base Hono and does **no such translation**. Handed a literal `{studentId}` path, it
registers a middleware for a pattern that can never match a real request path (`/api/students/abc`
has no literal `{studentId}` segment). Confirmed directly against Hono 4.12.34's router, isolated
from this app:

```ts
app.use("/items/{itemId}", mw); // never fires
app.get("/items/:itemId", handler); // fires fine — GET /items/abc -> "detail"
```

The wildcard-suffixed variant (`routes.use("/api/finance/refunds*", ...)`) has the same failure
mode but only once the sub-app is composed into the parent via `app.route("/", subApp)` — which
every module in this app is:

```ts
// invoked directly: fires
// mounted via app.route("/", subApp): silently never fires
routes.use("/api/finance/refunds*", requirePermission(PERMISSIONS.BILLING_READ));
```

`"/api/finance/refunds/*"` (slash before the star) has no such gap in either context. Neither of
these is a Hono bug report — it's this app's problem to route around — but the practical effect
was real: **every `requirePermission()`, `auditAction()`, and `requireChannel()` mounted this way
was dead code**, for every role, on every request, for as long as the pattern existed.

### How this was found

Built a live fuzz harness (`tests/security/authz-role-matrix.test.ts`) that mints a real JWT per
role and sends a real HTTP request through the real app for every route. A GUEST-role request to
`GET /api/finance/expenses/{expenseId}` (GUEST holds none of the permissions gated below) returned
`404 EXPENSE_NOT_FOUND` instead of `401`/`403` — meaning it reached `getExpense()`'s real database
query. `requirePermission(BILLING_UPDATE)` never ran.

### Blast radius

Grep for every `.use()` call whose literal path argument contains `{` found **155 call sites across
50 files** — essentially every parameterized route with a mount-time guard: students, teachers,
users (role assign, deactivate, sessions), families/guardians, discipline incidents and actions,
teacher evaluations and scores, attendance corrections and report exports, grade entry/config/
published grades, finance (expenses, invoices, payments, refunds, fee-structures, scholarships,
reports, installments), imports, notifications, tenancy provisioning/verification, audit log
export, invitations, academics (assignments, submissions, timetable, materials, exams, classes,
courses, subjects, terms, years), and every `/api/ai/students/{studentId}/*` route. Two more used
the glued-wildcard form (`refunds*`, `scholarship-discounts*`).

Real-world impact: **any authenticated caller of any role — including one holding zero relevant
permissions — could read or mutate any single-resource endpoint that used this pattern**, subject
only to whatever row-level RLS/tenant scoping the query itself carried (unaffected by this bug) and
any redundant inline check a handler happened to also carry (a few did, coincidentally — see #3).

### Fix

Mechanical, reviewed-before-applied codemod: every `.use()` call's literal path argument had
`{name}` replaced with `:name` (155 sites, 50 files), and the two glued-wildcard mounts
(`finance/refunds/routes.ts`, `finance/scholarships/routes.ts`) got the missing `/` before `*`.
Verified with an isolated Hono repro before touching any file, then confirmed against the live app:
the fuzz run above went from 47 failing deny/allow assertions to 0.

`tests/audit-coverage.test.ts`'s own path-matching (it correlates a route's `{param}` definition
with a same-line `"path"` string to find its `auditAction()` declaration) needed a matching update
— it now checks both the `{param}` and `:param` spelling of each path, since the two now legitimately
differ between a route's `createRoute()` definition and its `.use()` mount.

### Permanent regression gate

`tests/security/route-guard-wiring.test.ts` — a static scan (no DB, ~200ms) that fails any future PR
introducing either shape again: a `.use()` path containing `{`, or a wildcard glued to a non-empty
prefix. It already runs as part of `bun run test:security`, which CI's `cross-tenant-security` job
runs on every PR.

---

## 3. `GET /api/reports/children/{studentId}/breakdown`: same root cause, caught by luck

`routes.use(breakdownRoute.path, requirePermission(PERMISSIONS.GRADE_READ))` — `breakdownRoute.path`
is `createRoute()`'s own `{studentId}` path, so this is the identical bug via a variable reference
instead of a literal (my codemod only rewrote literal string arguments, deliberately — see the
"Why not regex-parse variables" note in the fuzz test's own docstring). The permission gate was
dead, **but this route was not actually exploitable**: its handler independently checks
`auth.roles.includes(ROLES.PARENT)` before touching any data (`src/modules/reports/routes.ts:118,165`),
which every non-PARENT caller still fails regardless of `GRADE_READ`. Fixed by mounting on the
literal `:studentId` path instead of the OpenAPI-style `.path` property.

---

## 4-6. High: three routes always 500 — registration-order route shadowing

Independent of the `.use()` bug above, three files register a parameterized `GET` route
(`{expenseId}`, `{invoiceId}`, `{importId}`) **before** a literal sibling path at the same depth
(`summary`, `batches`, `template`). Hono resolves an ambiguous path match by registration order, not
specificity — confirmed directly:

```ts
routes.openapi(detailRoute, ...);  // "/items/{itemId}", registered first
routes.openapi(summaryRoute, ...); // "/items/summary", registered second
// GET /items/summary -> hits detailRoute with itemId="summary"
```

Concretely: `GET /api/finance/expenses/summary` was always routed into `getExpense(schoolId,
"summary", storage)`, which failed a Postgres `uuid` cast (`invalid input syntax for type uuid:
"summary"`) and 500'd — for every caller, every time, regardless of data. Same shape for
`GET /api/finance/invoices/batches` (→ `getInvoiceDetail(..., "batches")`) and
`GET /api/imports/students/template` (→ `getImport(..., "template")`). None of the three had a live
functional test hitting them by their real path before this pass — only static OpenAPI-document
assertions that the route was registered, which can't catch a routing conflict.

**Fix**: reordered each file's `.openapi()` registrations so the literal path registers first
(`finance/expenses/routes.ts`, `finance/invoices/routes.ts`, `imports/routes/import-routes.ts`).
Verified each now returns its real payload (`{"categories":[],"grand_total":"0.000",...}`,
`{"invoice_batches":[],...}`, the actual CSV template) instead of a 500.

A fourth instance of the same _shape_ exists — `GET /api/evaluations/templates/{templateId}`
registered before `GET /api/evaluations/{evaluationId}/scores` — but it only collides on the literal
request path `/api/evaluations/templates/scores`, which requires a real `evaluationId` of exactly
`"templates"`; since `evaluationId` is always a real UUID in every legitimate call, no functional
endpoint is actually shadowed. Left as-is rather than reordered speculatively — flagged here for
visibility, not blocking.

---

## 7. High: `GET /api/approvals/queue` always 500s — mismatched enum types in a UNION

```
PostgresError: UNION could not convert type app.timetable_version_status to app.grade_submission_status
```

`listPendingApprovals` (`src/modules/grades/approval-queue-service.ts`) unions pending grade
submissions with pending timetable versions into one feed; the two `status` columns are different
Postgres enums with no implicit cast between them. This is a query-plan-level type error, not a
data-dependent one — it failed on every call, with or without pending items. **Fix**: cast both
arms to `::text` (matching `ApprovalQueueRow.status: string`, which was always the intended shape).
Verified: `{"items":[],"total":0}` instead of a 500.

## 8. High: school-settings lazy-init race

`getSchoolSettings` and `updateSchoolSettings` (`src/modules/tenancy/settings/service.ts`) both do a
plain check-then-insert: read the row, and if absent, `INSERT` a default row. Two concurrent
first-ever calls for the same school (two admin tabs, or a client retry racing the original) both
see zero rows and both reach the insert; the second hits `school_settings`' primary-key violation
directly and 500s instead of returning the settings the other request just created. Reproduced
deterministically inside the Tier A fuzz run's mixed concurrent load (2,664 requests across 296
operations at concurrency 24) — not a hypothetical. **Fix**: both insert sites now use
`ON CONFLICT (school_id) DO UPDATE SET school_id = EXCLUDED.school_id` (a no-op write, the standard
way to make `RETURNING` unconditional) / `ON CONFLICT (school_id) DO NOTHING` respectively.

## 9. Medium: reconciliation-run denial bypasses the error envelope

`POST /api/finance/reconciliation/run`'s API-key check returned a hand-rolled
`c.json({ type: "about:blank", ... }, 403)` on a bad/missing key — skipping
`errorHandlerMiddleware` entirely, so the response carried `Content-Type: application/json`
instead of the app's canonical `application/problem+json`, and no `request_id` correlation. Fixed
by `throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied")`, matching every
other denial in the app.

---

## 10. Medium: open redirect on the OAuth login round-trip

`apps/web/src/lib/auth/return-to.ts`'s `isInternalPath` accepted any path starting with `/` that
wasn't `//` — but not `/\evil.example`. Browsers normalize a leading `\` to `/` before parsing a
URL, so that string looks internal to the check (starts with `/`, isn't `//`) while actually
resolving as protocol-relative to `evil.example`. This value is stored in `sessionStorage` across
the OAuth provider round-trip and, on return, fed directly into react-router's `navigate()` in both
`LoginPage.tsx` and `CallbackPage.tsx` — exactly the shape of **GHSA-wrjc-x8rr-h8h6** (React Router
open redirect via backslash). A phishing page could set this value before the round-trip (or an
attacker who gets a victim to click a crafted deep link) and land the victim's _authenticated_
post-login redirect on an attacker-controlled origin.

**Fix**: `isInternalPath` now rejects any backslash or C0 control character anywhere in the path
(`return-to.ts`), independent of which router version is installed — 3 new regression tests
(`return-to.test.ts`) cover the leading-backslash, embedded-backslash, and control-character shapes.

**Why this isn't fully closed by a dependency bump**: `react-router`/`react-router-dom` were bumped
to `6.30.6` (latest 6.x) regardless, but the GHSA range for both relevant advisories
(`GHSA-wrjc-x8rr-h8h6`, `GHSA-337j-9hxr-rhxg`) is `<7.18.0` — there is no fixed 6.x release; the fix
landed only in the 7.x major line. A v7 migration is a real, separate initiative (different data
APIs, framework-mode vs. library-mode) and out of scope for a security pass to rush unreviewed. The
app-layer fix above closes the actual exploitable path independent of the router version, so the
residual advisory is accepted as a tracked, non-blocking item pending that migration.

---

## Dependency audit (`bun audit`, whole workspace lockfile)

Ran `bun audit --json` at the repo root (covers `apps/api`, `apps/web`, `apps/realtime`,
`apps/workers`, and every `packages/*` in one pass) and traced every hit's actual dependency chain
with `bun pm why` before deciding whether it was reachable at runtime — a severity label alone
doesn't say whether a package ships in a served response or only runs at build time on a laptop.

### Fixed

| Package                                          | Was     | Now     | Why it mattered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hono`                                           | 4.12.28 | 4.12.34 | Direct runtime dependency of `apps/api` and `apps/realtime`. 4 moderate CVEs: ReDoS in CORS middleware (`GHSA-8j4g-w8fx-2239`), JSX `memo()` retaining SSR output across requests — cross-user data leak (`GHSA-f23p-vx2j-j53r`), Proxy helper not stripping `Connection`-listed headers (`GHSA-79qm-7rj5-m7r9`), algorithmic-complexity DoS in the language middleware (`GHSA-54fx-42gc-7vw4`). All fixed in `4.12.34`; bumped to the minimum fixed patch rather than the latest `4.13.x` to keep the change to exactly what the CVEs required. |
| `react-router-dom` (+ transitive `react-router`) | 6.30.4  | 6.30.6  | Direct runtime dependency of `apps/web`. Latest available 6.x; see finding #10 for what remains unpatched at 6.x and why.                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Accepted risk (no runtime reachability, or no upstream fix exists)

| Package                                                                                    | Severity (GHSA)                                                                                     | Where it comes from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@xmldom/xmldom` 0.8.13                                                                    | Moderate — XML fragment injection via invalid `EntityReference.nodeName` **during serialization**   | Direct dep of `apps/workers` + transitive via `mammoth` (docx→html conversion of uploaded materials)                                                                                                                                                                                                                                                                                                                                                                                                                                             | No fix available: `mammoth`'s latest release (`1.12.2`, one patch above what's installed) still pins `@xmldom/xmldom` `^0.8.6`. Not reachable in this app's actual usage regardless — `mammoth` only **parses** untrusted docx XML through `xmldom`, it never serializes through it, and the advisory is specifically about the serializer. Tracked for whenever `mammoth` bumps its own pin.                                                                                                                                                                                              |
| `uuid` 9.0.1                                                                               | Moderate — missing buffer bounds check in `v3`/`v5`/`v6` **when a caller-supplied `buf` is passed** | Transitive, via `google-auth-library` → `gaxios` → `apps/workers`' `firebase-admin` chain                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Neither this app nor `gaxios` calls `uuid.v3/v5/v6` with a custom buffer anywhere in the call chain — only `v4` random generation is used. No reachable call path for the actual vulnerable code.                                                                                                                                                                                                                                                                                                                                                                                          |
| `brace-expansion`, `browserslist`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `storybook` | High per `bun audit`'s own severity field (several, incl. two `fast-uri` SSRF advisories)           | All confirmed via `bun pm why` to be devDependencies-of-devDependencies: `eslint`'s `minimatch`→`brace-expansion`; `vite`/`storybook`/`@sentry/vite-plugin`'s `postcss`/`browserslist`/`nanoid` chain; `commitlint` + `@seriousme/openapi-schema-validator`'s `ajv`→`fast-uri` (the two SSRF CVEs are in `ajv`'s JSON-schema `$ref` resolution, used here only to validate the generated OpenAPI doc at build time and to lint commit messages — never on a request path); `@redocly/openapi-core`/`cosmiconfig`'s `js-yaml`; `storybook` itself | Zero production runtime reachability — build/lint/commit tooling only, never bundled or executed in a served request. A compromised build-time dependency is still a real (if different) supply-chain concern; see `docs/runbooks/supply-chain-security.md` for that threat model. Forcing these to their fixed versions would mean bumping `eslint`, `vite`, `storybook`, `commitlint`, and `@redocly/openapi-core`/`openapi-typescript` — a real but separate maintenance pass, not a targeted security fix, and out of scope here given none of them carry actual exploitability today. |

### Mobile (`apps/mobile`, Dart/Flutter)

Dart's package ecosystem (`pub.dev`) has no equivalent of `npm audit`/`bun audit` — no maintained,
broadly-covering CVE database keyed to `pubspec.lock` versions exists to run here. `flutter pub
outdated` shows routine minor-version drift only (~30 packages a patch or two behind) and two
discontinued-but-not-flagged-vulnerable packages (`flutter_secure_storage_macos`, `js`). Nothing
actionable found; noted here as an honest gap in tooling coverage rather than a clean bill of
health this pass can actually certify.

---

## Secrets scan (git history)

No `gitleaks`/`trufflehog` preinstalled in this environment, and the existing CI `secret-scan` job
(`aquasecurity/trivy-action`, `scan-type: fs`) only ever scans the **working tree at HEAD** — a
secret committed and later deleted, in this repo's history or in a future PR's history, is invisible
to it despite that job's `fetch-depth: 0` (unused by `trivy fs`, which doesn't walk commits).

Pulled `zricethezav/gitleaks` via Docker and ran a genuine full-history scan:

```
docker run --rm -v "<repo>":/repo -w //repo zricethezav/gitleaks:latest \
  detect --source=/repo --log-opts="--all" -v --report-format json --report-path /repo/gitleaks-report.json
```

541 commits / ~41.6 MB scanned, 8 raw hits. Read every one in context (not just the rule name) —
all 8 are synthetic fixtures in `*.test.ts` files, none are real credentials:

| File                                             | What it actually is                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `subscriptions/__tests__/stripe-adapter.test.ts` | The literal string `sk_test_placeholder`                                       |
| `tests/auth/session-http.test.ts`                | A fabricated refresh-token fixture (`"0f1e2d3c-...-Xk7pQ2abc"`)                |
| `auth/tokens/opaque-token.test.ts` (×2)          | Fixture inputs for an "empty secret" / "base64 padding" parser test            |
| `auth/invitation/service.test.ts`                | A repeated-hex placeholder (`"abcdef0123456789"` x4)                           |
| `tests/security/csrf.test.ts`                    | Base64 that decodes to the literal string `"test-token-32-bytes-long-padding"` |
| `middleware/__tests__/idempotency.test.ts` (×2)  | The literal string `"mismatch-key-1"`                                          |

**Zero real secrets found.** `.gitleaks.toml` allowlists these six commits by exact SHA (not by rule
or pattern, to keep the allowlist as narrow as possible — a genuinely new secret added later in any
of these same files still fails the scan). Re-ran with the allowlist applied: `no leaks found`.

Closed the actual gap this revealed: added a permanent `secret-scan-history` job to
`.github/workflows/ci.yml` (`gitleaks/gitleaks-action@v2`, reading `.gitleaks.toml`), running
alongside — not replacing — the existing working-tree `secret-scan` job.

---

## SSRF review

Traced every outbound network call site in `apps/api` and `apps/workers` (`fetch(`, `new URL(`,
`axios.`, `http(s).get` — 29 matches) for a caller-influenceable target:

- OAuth provider callbacks (Google/Microsoft JWKS + token endpoints) — fixed, config-driven URLs,
  never built from request input.
- Cloudflare Turnstile captcha verification — fixed URL.
- ERPNext client (`erpnext/client.ts`, `workers/.../erpnext-client.ts`) — per-school base URL, but
  set by an admin during tenant provisioning, not by an arbitrary end user on a request.
- Tesseract OCR worker — operates on image bytes already fetched server-side from this app's own
  storage; never fetches a caller-supplied URL itself.
- OAuth error-redirect (`oauthErrorUrl`) — builds a URL from a fixed `FRONTEND_URL` config value
  plus an `ErrorCode` enum member, never raw request input.

No route in the current API surface accepts a URL, hostname, or webhook-callback target from a
caller and then makes a server-side request to it. The one real "URL-shaped input reaches app
logic" issue found was the open redirect (#10 above) — client-side, not server-side SSRF, and
already fixed.

## IDOR / cross-tenant

Not re-litigated here: `apps/api/tests/security/cross-tenant.test.ts` (773 lines, NFR-05) and
`row-scope.test.ts` (530 lines) already probe cross-tenant CRUD, forced-index-plan RLS regressions,
and pooled-GUC leaks across every tenant-scoped table, for both direct-object-reference and
row-level-scope shapes. Ran the full existing `tests/security` suite (`bun run test:security`) as
part of this pass — **462 tests, 0 failures** (the whole directory, including the new fuzz harness
below). Tier B of the new fuzz harness adds the piece that wasn't covered: live proof that the
_permission_ layer (not just the _row-scope_ layer) actually gates every guarded route end to end.

---

## The fuzz harness (acceptance criterion: "100% routes, role matrix")

`apps/api/tests/security/authz-role-matrix.test.ts` — two tiers, deliberately different in how
they get their expectations:

**Tier A** — generated from `openapi.json`: every one of **296 method+path operations** (226
routes) x every one of the **9 platform roles** (`SUPER_ADMIN`, `ORG_ADMIN`, `FINANCE`,
`INSTRUCTOR`, `TEACHING_ASSISTANT`, `STUDENT`, `PARENT`, `GUEST`, `SUPPORT_AGENT`) — **2,664 real
HTTP requests** through the real app and a real Postgres. The only claim: never a raw `500`, and
every `4xx` is the app's own well-formed `application/problem+json` envelope
(`errorHandlerMiddleware`'s documented contract — 5xx never leaks internals). This is honestly
100% route × role coverage for the crash/info-leak class of bug, and no more than that — it does
not know what any given route's _correct_ answer for a given role is. This tier alone found
findings #4, #5, #6, #7, #8 above.

**Tier B** — every one of the **90 distinct `requirePermission()` mount points** in `src/`, hand
-transcribed from source (deliberately not regex-parsed at runtime: a parser subtly wrong about
which permission gates which path would produce a worse outcome than no test at all — false
confidence instead of an honest gap). For each: `GUEST` (holds none of the permissions checked —
its only permissions, `course:read`/`lesson:read`, gate no route that exists in this app's actual
module set) must be denied `401`/`403`; `ORG_ADMIN` (holds every permission checked — it's every
permission except `user:impersonate`/`organization:create`/`organization:delete`/`apiKey:*`, none
of which appear in this table) must not be denied on permission grounds. **178 live assertions**
that exercise the real enforcement path end to end — the thing `permission-guard-coverage.test.ts`'s
static text-presence check cannot see: a guard that's present in the file but wired to a path that
never matches (exactly what findings #1-3 were).

One row (`GET /api/grades/published/students/{studentId}/terms/{termId}`) is annotated
`allowedRoleAlsoRestrictedBy` and skips the "ORG_ADMIN not denied" half: that route deliberately
restricts to `STUDENT`/`PARENT` callers even though `ORG_ADMIN` holds `grade:read` too (a student's
grades are visible to the student and their parent, not to staff via this endpoint) — the
permission is a floor, not the full story, and the test says so rather than asserting something the
route was never meant to allow.

`apps/api/tests/security/route-guard-wiring.test.ts` is the permanent regression gate for the root
cause findings #1-2 (see that section for detail).

---

## Reproducing this pass

```bash
# Postgres + Redis
bun run db:up

# Live fuzz + wiring gate + everything else in tests/security (~462 tests)
POSTGRES_PASSWORD=studafy_test \
TEST_DATABASE_URL='postgresql://studafy_test:studafy_test@127.0.0.1:54329/postgres?sslmode=disable' \
DATABASE_SSL_MODE=disable \
bun run --cwd apps/api test:security

# Dependency audit (whole workspace)
bun audit --json

# Secrets, full history (needs Docker)
docker run --rm -v "$(pwd)":/repo -w /repo zricethezav/gitleaks:latest \
  detect --source=/repo --log-opts="--all" --config=/repo/.gitleaks.toml
```

## What this pass did not cover

- A full end-to-end run of every DB-integration test file in `apps/api` simultaneously (not just
  `tests/security`) was attempted but hung on an unrelated environment issue: a second, unrelated
  Docker project's unrelated Redis container (version 3.0.504) on this machine's default Redis port,
  which some `bullmq`-backed queue tests reach instead of this repo's own `db/compose.yml` Redis and
  then retry indefinitely. Not a finding — a local machine/port conflict — but flagging it means the
  full non-`tests/security` integration matrix wasn't re-run end-to-end in this same pass, beyond
  the targeted module tests exercised directly (finance, grades, imports, tenancy/settings,
  families) and the full non-DB unit suite (2,297 tests, 0 failures).
- Mobile (`apps/mobile`) dependency vulnerabilities: no tooling gap was closed here (see above).
- `apps/web`'s own client-side dependency surface beyond what `bun audit` covers (e.g. a
  browser-based DAST/ZAP pass) was not run.
