# Edge security conventions

What sits between a client and the application in production, and the conventions that follow from
it. Production runs on fly.io ([`infra/fly/README.md`](../../infra/fly/README.md)); the per-app
settings quoted below are in `infra/fly/<app>.toml`.

## What's actually in front of a request

```
client ──TLS──► fly proxy (fly certificate for api.studafy.com / the web domains)
                   ├─ plain HTTP → redirected to HTTPS (force_https = true)
                   └─ HTTPS → forwarded to the app's internal_port,
                              with the visitor's address in Fly-Client-IP
```

There is **no WAF** in front of fly — the AWS ALB, its WAF managed rule groups and its edge rate
limits were retired with the AWS stack. Request filtering and rate limiting happen in the
application: `apps/api`'s own rate limits, CORS, CSRF and security-header middleware
(`apps/api/src/app.ts`).

## Client address

fly's proxy puts the visitor's address in `Fly-Client-IP` and appends its own address last in
`X-Forwarded-For`. `CLIENT_IP_HEADER = "fly-client-ip"` (`infra/fly/api.toml`) tells the api to key
rate limits, audit rows and security events on that header (`apps/api/src/env.ts`). Without it the
last `X-Forwarded-For` entry — the proxy — is used and every visitor lands in one bucket (it did on
fly, 2026-11-10).

## TLS

| Check                      | How production satisfies it                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Certificate validity/chain | `fly certs add <domain> --app <app>`; fly issues and renews the certificate as long as the DNS records at Vercel stay in place ([`infra/fly/README.md#domains`](../../infra/fly/README.md#domains)). |
| No plaintext path          | `force_https = true` on every public app's `[http_service]`.                                                                                                                                         |
| HSTS present               | Set by `apps/api` (`app.ts`), not the proxy — see [HSTS lives in the app, not the LB](#hsts-lives-in-the-app-not-the-lb) below.                                                                      |

Protocol and cipher policy are fly's; nothing in this repo configures them.

## HSTS lives in the app, not the LB

fly's proxy terminates TLS and forwards to the app without adding response headers, so the
response headers have to be set by the application or nowhere. This is what's implemented:
`apps/api/src/middleware/securityHeaders.ts` sets
`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on every response via Hono
middleware, registered in `apps/api/src/app.ts` and verified by
`apps/api/tests/security/security-headers.test.ts` (and, as a wiring check, `apps/api/src/app.test.ts`).

As of ST-067 that middleware also carries the rest of the response header matrix (CSP,
X-Frame-Options, Referrer-Policy, and the Cross-Origin-\* family) — see
[docs/security/web_defense_matrix.md](../security/web_defense_matrix.md). HSTS was previously an
inline `app.use` in `app.ts`; it moved so there is exactly one place that owns response headers.

`apps/realtime` does not set this header; it is reached only through the api's `/ws` route
(fly-replay), and is off while live updates are deferred.

## Verifying the acceptance criteria

- **TLS and HSTS**: `curl -sI https://api.studafy.com/healthz` shows
  `strict-transport-security: max-age=63072000; includeSubDomains; preload`; an SSL Labs or
  `testssl.sh` run against `api.studafy.com` grades the certificate and protocol support.
- **No plaintext path**: `curl -sI http://api.studafy.com/healthz` answers with a redirect to
  `https://`.

## External penetration testing

With no WAF in front of fly, there is nothing to allowlist for a tester; the api's own rate limits
still apply, keyed on `Fly-Client-IP`. Commissioning process, scope, and the cross-tenant standing
objective: `docs/runbooks/security/st-250-external-pentest-commissioning.md`.

## Known gaps

- **No WAF and no edge rate limiting.** Every request reaches the application; the api's own
  middleware is the only filter.
- **`apps/realtime` has no HSTS middleware.** Only `apps/api` does. Add it there too if realtime is
  ever served on a host of its own.
- **No request-level access logs at the edge.** What exists is the apps' own request logs, shipped
  to Axiom by `infra/fly/log-shipper.toml`.
