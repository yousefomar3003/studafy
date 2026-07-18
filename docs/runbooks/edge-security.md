# Edge security conventions

Source: [`infra/terraform/modules/edge`](../../infra/terraform/modules/edge). This doc is the
conventions and acceptance-criteria verification steps that don't fit in the module's own
`README.md` — read that first for inputs/outputs and the WAF rule table.

## What's actually in front of a request

```
client ──TLS──► aws_lb.this (module.edge)
                   ├─ :80  → 301 redirect to :443
                   └─ :443 → aws_wafv2_web_acl.this evaluates every request
                                ├─ AWSManagedRulesCommonRuleSet (OWASP CRS) — block on match
                                ├─ AWSManagedRulesSQLiRuleSet   — block on match
                                ├─ rate-limit /auth              — block after auth_rate_limit/5min/IP
                                ├─ rate-limit /schools/register — block after schools_register_rate_limit/5min/IP
                                └─ default: allow → listener's default action (fixed 404 today;
                                                     a future compute tier's target group later)
```

WAF evaluation happens on the ALB itself (`aws_wafv2_web_acl_association`), before any listener
rule runs — a blocked request never reaches even the fixed-404 default action, let alone a real
backend.

## TLS: why this earns an A, not just "HTTPS works"

A scanner (Qualys SSL Labs, `testssl.sh`, etc.) grades more than "is there a cert":

| Check                          | How `modules/edge` satisfies it                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Modern protocol/cipher support | `ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"` — TLS 1.2 floor, TLS 1.3 available, no CBC/RC4/3DES.                             |
| Certificate validity/chain     | `aws_acm_certificate` + DNS validation; ACM auto-renews as long as the validation record stays in place — nothing to rotate manually. |
| No plaintext path              | Port 80's only action is a 301 redirect; nothing forwards from it.                                                                    |
| Malformed request handling     | `drop_invalid_header_fields = true` on the ALB.                                                                                       |
| HSTS present                   | Set by `apps/api` (`app.ts`), not the ALB — see [HSTS lives in the app, not the LB](#hsts-lives-in-the-app-not-the-lb) below.         |

**Certificate auto-renewal, concretely:** ACM renews DNS-validated certificates automatically
before expiry, provided the validation CNAME record it created (`aws_route53_record.cert_validation`
in the module) still exists and still resolves. Don't delete that record once the certificate is
issued — it's not a one-time bootstrap artifact, ACM re-checks it on every renewal.

## HSTS lives in the app, not the LB

This is a genuine AWS limitation, not an oversight: an `aws_lb_listener` action is one of
`forward` / `redirect` / `fixed-response` — none of them can inject a header into a response that
already has one (i.e. a real backend response once a target group exists). There's no ALB feature
called "response header policy" the way CloudFront has one. Options considered:

- **CloudFront in front of the ALB**, using its response-headers-policy feature. Out of scope —
  the ticket asks for LB + TLS + WAF, not a CDN, and adding one is a bigger architectural decision
  than this ticket should make unilaterally.
- **Set it in the application**, since that's the only layer that actually controls the response.
  This is what's implemented: `apps/api/src/middleware/securityHeaders.ts` sets
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on every response via
  Hono middleware, registered in `apps/api/src/app.ts` and verified by
  `apps/api/tests/security/security-headers.test.ts`.

  As of ST-067 that middleware also carries the rest of the response header matrix (CSP,
  X-Frame-Options, Referrer-Policy, and the Cross-Origin-* family) — see
  [docs/security/web_defense_matrix.md](../security/web_defense_matrix.md). HSTS was previously an
  inline `app.use` in `app.ts`; it moved so there is exactly one place that owns response headers.

Consequence: HSTS is only actually served once a request reaches `apps/api` — i.e. once a compute
tier exists and is wired to `module.edge`'s `https_listener_arn` (it doesn't exist yet, see the
module README). Until then, a scanner run against the bare ALB will correctly report HSTS as
missing on the `fixed-response` 404 the listener returns today. That's an honest gap, not a bug:
re-run the scan once a compute tier is live behind this LB. `apps/realtime` does not set this
header yet — add the same middleware there if/when it also sits behind this ALB.

## Verifying the acceptance criteria

The module's own README has the exact commands (TLS scan, redirect check, SQLi/XSS payloads,
rate-limit loop). Two things worth calling out here:

- **The WAF payload tests work today even without a compute tier**, because they only need to
  reach the WAF, not a real application — a blocked request never gets past
  `aws_wafv2_web_acl_association` to hit the listener's fixed-404 default action. A `403` proves
  the WAF rule fired; you don't need `apps/api` deployed to prove it.
- **The rate-limit test is approximate.** AWS WAFv2 rate-based rules evaluate over a rolling
  5-minute window and the exact request count at which blocking starts can vary by a handful of
  requests around the configured limit (AWS's own documented behavior, not a bug in this module).
  Don't treat "blocked at request 301, not exactly 301" as a failure.

## Known gaps

- **No target group, no routing.** Same gap called out in the module README — this doc doesn't
  repeat the reasoning, just flags that "requests reach a real backend" isn't testable until a
  compute-tier ticket exists.
- **`apps/realtime` has no HSTS middleware.** Only `apps/api` does. Add it there too before
  `apps/realtime` is routed through this LB.
- **ALB access logs are off by default** (`access_logs_bucket_id = null`). There's no bucket
  provisioned for them yet — `modules/storage`'s two buckets serve a different purpose. If
  request-level ALB access logs (as opposed to WAF's own request logs, which are on by default)
  become a requirement, that's a small follow-up: add a bucket and pass its ID in.
