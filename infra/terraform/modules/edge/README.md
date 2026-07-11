# `edge`

Internet-facing ALB, TLS (ACM, DNS-validated), HTTP→HTTPS redirect, and a regional WAFv2 web ACL
(OWASP core rule set + SQLi rule set + rate limits on `/auth` and `/schools/register`). Depends on
`module.network` for subnets and the ALB security group. Edge security conventions and how to
exercise the acceptance criteria: [`docs/runbooks/edge-security.md`](../../../../docs/runbooks/edge-security.md).

## What this module does not do

- **It does not create a target group, or forward any traffic anywhere.** No compute tier exists
  yet in this repo (`infra/terraform/README.md`'s status note) and no path→service routing
  contract has been decided (which of `apps/api`/`apps/realtime` owns which prefix). The HTTPS
  listener's default action is a fixed `404` response — enough to point a TLS scanner or a WAF
  payload test at. `https_listener_arn` is exported specifically so a future compute-tier module
  can attach `aws_lb_target_group` + `aws_lb_listener_rule` resources without editing this module.
- **It does not set the HSTS header.** An ALB listener action cannot inject arbitrary response
  headers — only a `redirect` or a `fixed-response` body, neither of which reaches a real
  response once a target group exists. HSTS is set in `apps/api` itself (see
  `docs/runbooks/edge-security.md`); this module cannot honestly claim to enforce it from
  Terraform alone.
- **It does not create the Route 53 hosted zone.** `route53_zone_id` comes from the shared
  bootstrap stack and must already exist — same "create this out of band first" pattern as
  `modules/network`'s `bastion_key_name`. `staging-api.studafy.com` / `api.studafy.com` are
  already hardcoded in `apps/mobile/lib/src/core/config/app_environment.dart`; this module aliases
  the ALB to whichever `domain_name` you pass, it doesn't invent one.
- **It does not create an S3 bucket for ALB access logs.** `access_logs_bucket_id` is `null` by
  default (logging off); pass an existing bucket's ID to turn it on. `modules/storage`'s two
  buckets (`app-files`, `backups-archive`) serve a different purpose — this module doesn't
  provision a third one unasked.

## Topology

```
internet ──80/443──► alb security group (module.network) ──► aws_lb.this
                                                                 │
                                              ┌──────────────────┴──────────────────┐
                                              │                                      │
                                     listener :80 (HTTP)                   listener :443 (HTTPS)
                                     redirect → HTTPS, 301                 ACM cert, ssl_policy
                                                                            default: fixed 404
                                                                                 │
                                                                     aws_wafv2_web_acl.this
                                                                     (associated, REGIONAL)
                                                                       ├─ AWSManagedRulesCommonRuleSet
                                                                       ├─ AWSManagedRulesSQLiRuleSet
                                                                       ├─ rate-limit /auth
                                                                       └─ rate-limit /schools/register
```

The ALB uses `module.network`'s `alb_security_group_id` directly rather than creating a second
security group — there is exactly one place ALB network reachability is defined
(`modules/network/security_groups.tf`).

## TLS

- Certificate: `aws_acm_certificate` with `validation_method = "DNS"`, validated via
  `aws_route53_record` entries in `route53_zone_id` and an `aws_acm_certificate_validation`
  resource the HTTPS listener depends on — a listener is never created pointing at a
  still-pending certificate.
- `ssl_policy` defaults to `ELBSecurityPolicy-TLS13-1-2-2021-06`: TLS 1.2 minimum, TLS 1.3
  available, no legacy ciphers. This is the input a scanner actually grades to award an A; don't
  loosen it without re-running the scan.
- `drop_invalid_header_fields = true` on the ALB rejects malformed/ambiguous request headers —
  also part of what a scanner checks.

## WAF rules

| Rule                          | Type                                                      | Action                       | Purpose                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws-common-rule-set`         | AWS managed rule group                                    | Group's own (block on match) | `AWSManagedRulesCommonRuleSet` **is** AWS's OWASP Core Rule Set implementation — this satisfies the ticket's "WAF with OWASP core ruleset" literally, not by analogy. |
| `aws-sqli-rule-set`           | AWS managed rule group                                    | Group's own (block on match) | `AWSManagedRulesSQLiRuleSet`, layered on top per AWS's own guidance that CRS alone under-catches SQLi.                                                                |
| `rate-limit-auth`             | Rate-based, scoped to `/auth` (`STARTS_WITH`)             | Block                        | `auth_rate_limit` (default 300) requests / 5-min rolling window / source IP.                                                                                          |
| `rate-limit-schools-register` | Rate-based, scoped to `/schools/register` (`STARTS_WITH`) | Block                        | `schools_register_rate_limit` (default 100 — AWS's WAFv2 floor) requests / 5-min window / source IP.                                                                  |

`default_action` on the web ACL itself is `allow` — only requests matching one of the rules above
are blocked; everything else reaches the ALB's listener default action.

Every rule and the web ACL itself report to CloudWatch metrics (`sampled_requests_enabled = true`,
so you can pull the actual blocked request from the console, not just the count). Request-level
WAF logs (every match, block or otherwise) ship to CloudWatch Logs at
`aws-waf-logs-<name_prefix>-edge` when `enable_waf_logging` is true (default).

## Usage

```hcl
module "edge" {
  source = "./modules/edge"

  name_prefix            = module.naming.name_prefix
  public_subnet_ids      = module.network.public_subnet_ids
  alb_security_group_id  = module.network.alb_security_group_id
  domain_name             = "api.studafy.com"
  route53_zone_id         = data.terraform_remote_state.bootstrap.outputs.route53_zone_id
}
```

## Verifying the acceptance criteria

```bash
# TLS rating — run against alb_dns_name or domain_name, e.g. with testssl.sh:
testssl.sh --severity HIGH "$(terraform output -raw edge_alb_dns_name)"

# HTTP -> HTTPS redirect:
curl -sI "http://$(terraform output -raw edge_alb_dns_name)" | head -1
# expect: HTTP/1.1 301 Moved Permanently, Location: https://...

# WAF blocks a test SQLi payload:
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://$(terraform output -raw edge_domain_name)/?id=1%20OR%201=1"
# expect: 403 (WAF), not the listener's own 404 default action

# WAF blocks a test XSS payload:
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://$(terraform output -raw edge_domain_name)/?q=<script>alert(1)</script>"
# expect: 403

# Rate limit on /auth (300 req/5min default) — expect the response code to flip to 403
# partway through:
for i in $(seq 1 320); do
  curl -s -o /dev/null -w '%{http_code} ' "https://$(terraform output -raw edge_domain_name)/auth/login"
done
```

## Inputs

| Name                          | Type           | Default                               | Description                                                                  |
| ----------------------------- | -------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `name_prefix`                 | `string`       | —                                     | Resource name prefix, from `module.naming.name_prefix`.                      |
| `public_subnet_ids`           | `list(string)` | —                                     | Required, ≥2 entries. From `module.network.public_subnet_ids`.               |
| `alb_security_group_id`       | `string`       | —                                     | From `module.network.alb_security_group_id`.                                 |
| `domain_name`                 | `string`       | —                                     | Public hostname, e.g. `api.studafy.com`. Must resolve inside the zone below. |
| `route53_zone_id`             | `string`       | —                                     | Existing public hosted zone ID, from the shared bootstrap stack.             |
| `create_dns_record`           | `bool`         | `true`                                | Alias `domain_name` at the ALB. Set `false` if DNS is managed elsewhere.     |
| `ssl_policy`                  | `string`       | `ELBSecurityPolicy-TLS13-1-2-2021-06` | ALB HTTPS listener security policy.                                          |
| `enable_deletion_protection`  | `bool`         | `false`                               | Override `true` in `prod.tfvars`.                                            |
| `idle_timeout`                | `number`       | `60`                                  | ALB idle connection timeout, seconds.                                        |
| `access_logs_bucket_id`       | `string`       | `null`                                | S3 bucket for ALB access logs. `null` disables logging.                      |
| `access_logs_prefix`          | `string`       | `"alb"`                               | Key prefix within `access_logs_bucket_id`.                                   |
| `auth_rate_limit`             | `number`       | `300`                                 | Requests / 5-min / IP on `/auth*` before block. Floor: 100.                  |
| `schools_register_rate_limit` | `number`       | `100`                                 | Requests / 5-min / IP on `/schools/register` before block. Floor: 100.       |
| `enable_waf_logging`          | `bool`         | `true`                                | Ship WAF request logs to CloudWatch Logs.                                    |
| `waf_log_retention_days`      | `number`       | `90`                                  | Retention for WAF request logs.                                              |

## Outputs

| Name                                     | Description                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `alb_arn`, `alb_dns_name`, `alb_zone_id` | The load balancer.                                                      |
| `alb_security_group_id`                  | Echoes the input, for convenience.                                      |
| `https_listener_arn`                     | Attach point for a future compute tier's target groups/listener rules.  |
| `http_listener_arn`                      | The redirect-only listener — nothing should ever attach rules here.     |
| `certificate_arn`                        | The validated ACM certificate bound to the HTTPS listener.              |
| `domain_name`                            | Echoes the input.                                                       |
| `web_acl_arn`, `web_acl_id`              | The WAFv2 web ACL.                                                      |
| `waf_log_group_name`                     | Where WAF request logs land. `null` if `enable_waf_logging` is `false`. |
