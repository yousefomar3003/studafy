# Web defense matrix

The browser-facing defenses `apps/api` applies to every request: the response header matrix, the
CORS origin allowlist, and CSRF protection. Delivered by ST-067.

Three middlewares, registered in this order in [`apps/api/src/app.ts`](../../apps/api/src/app.ts):

| Order | Middleware                                                                      | Scope    | Job                                               |
| ----- | ------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| 1     | [`corsMiddleware`](../../apps/api/src/middleware/cors.ts)                       | `*`      | Answers preflights; grants access-control headers |
| 2     | [`securityHeadersMiddleware`](../../apps/api/src/middleware/securityHeaders.ts) | `*`      | Injects the response header matrix                |
| 3     | [`csrfMiddleware`](../../apps/api/src/middleware/csrf.ts)                       | `/api/*` | Double-submit cookie check on mutations           |

The order matters. CORS is first so a preflight is answered and a disallowed origin is dealt with
before anything downstream claims a connection or a lock. CSRF is last of the three so preflights
never reach it. All three sit after `requestIdMiddleware`, so a rejection can carry a `request_id`.

Rejections are thrown as `HTTPException` and rendered by
[`errorHandlerMiddleware`](../../apps/api/src/middleware/errorHandler.ts) as RFC 9457
`application/problem+json`. There is no separate security error envelope, on purpose — a second one
would drift from the first.

## Response header matrix

| Header                              | Value                                           | Why                                                                         |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `Content-Security-Policy`           | see below                                       | Stops injected script from executing; the main anti-XSS control             |
| `Strict-Transport-Security`         | `max-age=63072000; includeSubDomains; preload`  | Forces HTTPS; 2 years clears the preload-list minimum                       |
| `X-Frame-Options`                   | `DENY`                                          | Clickjacking. `DENY`, not `SAMEORIGIN` — nothing here is meant to be framed |
| `X-Content-Type-Options`            | `nosniff`                                       | Stops a JSON response being re-interpreted as HTML or script                |
| `Referrer-Policy`                   | `strict-origin-when-cross-origin`               | Keeps paths and query strings (ids, tokens) out of cross-origin referrers   |
| `Permissions-Policy`                | geolocation/mic/camera/payment/usb/sensors `()` | Denies device APIs an API server never needs                                |
| `X-Permitted-Cross-Domain-Policies` | `none`                                          | Denies legacy Flash/PDF cross-domain policy files                           |
| `Cross-Origin-Opener-Policy`        | `same-origin`                                   | Severs the opener reference, containing cross-origin popup attacks          |
| `Cross-Origin-Resource-Policy`      | `same-site`                                     | Blocks cross-site subresource embedding of API responses                    |

`Cross-Origin-Embedder-Policy` is deliberately **not** set. `require-corp` buys cross-origin
isolation, which matters to a document wanting `SharedArrayBuffer` or high-resolution timers; this
is a JSON API that owns no such document. What it does buy is a requirement that every cross-origin
subresource opt in via CORP, which breaks embedders for no gain here.

### Content Security Policy

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:;
object-src 'none'; media-src 'self'; frame-src 'none'; base-uri 'self'; form-action 'self'
```

`style-src` carries `'unsafe-inline'` because the Scalar docs UI needs it. **`script-src` must never
follow** — that is the directive that actually stops reflected XSS from executing, and a test asserts
it stays free of `unsafe-inline`, `unsafe-eval`, and `*`.

Served as `Content-Security-Policy-Report-Only` in development, enforcing everywhere else, so a new
directive surfaces as a console violation locally before it can break a deployed page.

**CSP-exempt paths:** `/docs` and `/openapi.json`. Scalar loads its bundle from a CDN, so
`script-src 'self'` blanks the page. Widening `script-src` globally to admit that CDN would weaken
the policy on every real API route to accommodate one dev-only page, so the exemption is scoped
instead. `/docs` is gated behind `docsEnabled` and is off in production. Every other header still
applies to those paths.

## CORS

The allowlist is **data, not code**: `CORS_ALLOWED_ORIGINS`, a comma-separated list of bare absolute
origins.

```bash
CORS_ALLOWED_ORIGINS="https://app.studafy.com,https://api.studafy.com"
APP_ENV=production
```

| `APP_ENV`     | Origins                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `development` | `CORS_ALLOWED_ORIGINS` if set, else `localhost:{3000,5173}` and `127.0.0.1` equivalents |
| `staging`     | `CORS_ALLOWED_ORIGINS` — **required**                                                   |
| `production`  | `CORS_ALLOWED_ORIGINS` — **required**                                                   |

`APP_ENV` exists because `NODE_ENV` cannot express staging: a staging box runs a production build
(`NODE_ENV=production`) against non-production origins.

An earlier revision hardcoded a per-environment origin map in `config/security.ts`. It had already
drifted from the infrastructure that provisions the hosts — it listed `studafy.com` and
`www.studafy.com` while `infra/terraform/environments/prod/prod.tfvars` provisions
`app.studafy.com`. A table in application code can only ever be a second copy of a fact Terraform
owns, so it is deliberately no longer one. **Keep `CORS_ALLOWED_ORIGINS` in step with
`cdn_domain_name` / `edge_domain_name` in the tfvars for that tier.**

Guardrails, enforced at bootstrap by `envSchema` in [`apps/api/src/env.ts`](../../apps/api/src/env.ts):

- A deployed tier with an empty or missing `CORS_ALLOWED_ORIGINS` **fails to boot**. It cannot fall
  back to the localhost defaults and quietly accept credentialed requests it should not.
- Entries must be bare origins. Wildcards (`https://*.studafy.com`), paths (`https://x.com/app`),
  scheme-less hosts, and non-HTTP schemes are all rejected — an entry carrying a path can never
  equal an `Origin` header, so it would sit in the config looking like protection it does not give.

Matching is exact after lowercasing and stripping a trailing slash. Substring and suffix matching are
not used, which is what stops `http://localhost:5173.attacker.com` and `http://evil-localhost:5173`.

The response is never `Access-Control-Allow-Origin: *`. A wildcard is invalid alongside
`Allow-Credentials: true`, and every browser rejects the pair. A disallowed origin simply receives no
access-control headers.

**CORS is not authorization.** It is a browser-enforced restriction on _reading_ a response. A
non-preflight request from a foreign origin still executes; the browser just refuses to hand the body
to the calling page. Anything that must not happen at all needs an authorization check in the handler.

## CSRF

Double-submit cookie, stateless. The server issues a 256-bit CSPRNG token in a **JS-readable**
cookie; the client echoes it in a header; the server compares the two in constant time.

The comparison is the whole mechanism: an attacker's cross-origin page can cause the cookie to be
_sent_, but the same-origin policy stops it from _reading_ the cookie to forge the matching header.

|               |                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------ |
| Cookie        | `XSRF-TOKEN` — `SameSite=Strict`, `Path=/`, `Secure` outside local dev, **not** `HttpOnly` |
| Header        | `X-XSRF-TOKEN`                                                                             |
| Gated methods | `POST`, `PUT`, `PATCH`, `DELETE`                                                           |
| Scope         | `/api/*`                                                                                   |

`HttpOnly` is absent by design — the client must be able to read the cookie. That is the "double
submit", and it is safe because the token is not a credential: it authenticates nothing on its own.

**Client contract:** make any safe request to `/api/*` to receive the cookie, read `XSRF-TOKEN`, and
send its value as `X-XSRF-TOKEN` on every mutation.

### Who is exempt

**Bearer-token callers.** A request carrying `Authorization: Bearer …` skips the check entirely.
Bearer flows are not vulnerable to CSRF: an attacker's page cannot make a browser attach an
`Authorization` header the way it automatically attaches cookies. This is what keeps mobile clients
working. A Bearer caller is exempt even if it also sends cookies, so an incidental cookie in a mobile
webview cannot break it. Other schemes (`Basic`, …) are **not** exempt.

**Exempt paths:** `/healthz`, `/readyz`, `/docs`, `/openapi.json`, and `/api/webhooks`. The webhook
path is exempt because ERPNext authenticates by HMAC signature over the request body, not by a
session token — it has no cookie to forge and no way to read one.

### Rejections

`403` with `application/problem+json` and the tracing `request_id`:

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "CSRF token missing or invalid",
  "code": "AUTHZ_FORBIDDEN",
  "request_id": "c565532e-657b-4070-b734-69b0228bde83"
}
```

`detail` is deliberately the same string for a missing token and a mismatched one — the distinction
is recorded in the logs, not handed to the caller.

The `request_id` matches the response's `X-Request-Id` and the log lines for that request.

A violation is logged as a structured `warn` — `reason` (`missing_token` | `token_mismatch`), path,
method, client IP, user agent, `request_id` — and never contains the token values.

## Performance

The acceptance target is **< 0.5 ms** for the whole chain. Measured overhead is **~0.03 ms**, a ~16×
margin.

```bash
SECURITY_CHAIN_BENCHMARK=1 bun test tests/benchmark/security-chain-benchmark.test.ts
```

The benchmark asserts a **delta** between two apps identical but for the security chain, not a
wall-clock time — an absolute budget on a shared runner mostly measures Hono's dispatch and Bun's
`Request`/`Response` construction. See the header comment in
`tests/benchmark/request-context-benchmark.test.ts` for the full reasoning, and the NFR-05 probe whose
absolute budget had to be widened twice.

What keeps it cheap:

- **Zero database I/O.** Token validation is a hash comparison. No reads, no index lookups, on the
  accept path or the reject path.
- **Precomputed headers.** CSP and HSTS strings are built once at registration, not per request.
- **Early termination.** A disallowed origin or a failed token check short-circuits before routing,
  so no connection pool or transaction lock is ever claimed.

## Verifying

```bash
cd apps/api
bun run test:security     # tests/security — CORS, CSRF, headers, cross-tenant
bun test                  # full suite
SECURITY_CHAIN_BENCHMARK=1 bun test tests/benchmark/security-chain-benchmark.test.ts
```

Against a running instance:

```bash
# Foreign origin gets no access-control headers
curl -i -X OPTIONS -H "Origin: https://evil.com" localhost:3000/healthz

# Cookie mutation without the CSRF header is rejected
curl -i -X POST -H "Cookie: XSRF-TOKEN=abc" localhost:3000/api/anything

# Bearer mutation passes through
curl -i -X POST -H "Authorization: Bearer test" localhost:3000/api/anything
```

## Known gaps

- **No auth or session subsystem exists yet.** There is no session cookie issuer and no auth
  middleware in `apps/api/src`. CSRF therefore gates on the _absence_ of a Bearer header rather than
  the presence of a session cookie: cookie-gating would enforce nothing today, and would fail open
  tomorrow for any cookie name other than the one guessed in advance. Revisit when sessions land, but
  note the current rule stays correct — it is strictly broader.

- **CSRF violations are logged, not written to `audit_logs`.** Two reasons, and both should be
  re-checked when auth ships. `emitAuditLog` resolves identity from the tenant GUCs that
  `withTenantTx` sets, and a rejected unauthenticated request has no `user_id` or `school_id` to
  attribute the event to. And a database round-trip on the reject path contradicts ST-067's own
  "zero database reads" and sub-0.5 ms requirements — it would also hand an unauthenticated attacker
  a cheap way to generate write load. If these events are wanted in `audit_logs`, the right shape is
  an async batched sink, not an inline write.

- **ST-067's "Tenant Isolation Checks" are not implemented, and should not be.** The ticket asks the
  middleware to assert that identity metadata such as `school_id` embedded in the CSRF payload
  mirrors the schema. A double-submit token is an opaque random value carrying no identity **by
  design**; embedding tenant metadata in it would weaken it and create a second, unsigned source of
  tenant identity alongside the real one. Tenant isolation is enforced where it belongs — Postgres
  RLS, covered by [NFR-05](./NFR-05_cross_tenant_isolation.md).

- **`apps/realtime` has no security headers.** Only `apps/api` runs this middleware. See the same
  note in [edge-security.md](../runbooks/edge-security.md).
