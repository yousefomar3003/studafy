# `cdn`

CloudFront distribution for apps/web's built bundle: a private S3 origin (Origin Access Control,
never a public bucket), long-cache immutable assets, no-cache HTML, a DNS-validated ACM certificate
in us-east-1 (CloudFront's hard requirement, regardless of the stack's home region), and a
GitHub-OIDC deploy role that syncs the bundle and invalidates the distribution. Cache policy
rationale and the exact deploy/verify commands:
[`docs/runbooks/cdn-cache-policy.md`](../../../../docs/runbooks/cdn-cache-policy.md).

## What this module does not do

- **It does not build apps/web, or run `aws s3 sync`.** No `.github/workflows` file exists
  anywhere in this repo yet (same gap `modules/registry`'s README calls out) — `deploy_role_arn`
  is the identity a future deploy job assumes, not a working pipeline today.
- **It does not create a second GitHub Actions OIDC provider.** AWS allows exactly one per URL per
  account; `modules/registry` already created it and its own `main.tf` comment calls for reuse once
  a second caller needs one. This module takes `github_oidc_provider_arn` as an input
  (`module.registry.github_oidc_provider_arn`) instead of duplicating the resource.
- **It does not set per-object `Cache-Control` metadata on upload.** Both cache classes are
  enforced by CloudFront cache policies and response headers policies (`distribution.tf`), not by
  trusting a deploy script to tag objects correctly — no build/deploy tooling exists yet in this
  repo to do that tagging (same "nothing built to set this yet" gap `modules/storage`'s SSE-S3 note
  calls out). The behavior is self-contained in Terraform regardless of what a future deploy script
  does or doesn't set.
- **It does not provision a WAF web ACL.** The ticket's "Depends On: load balancer, TLS, WAF"
  (`modules/edge`) is a sequencing dependency — `module.edge` fronts the API origin
  (`api.studafy.com`), a different domain and different threat model (SQLi/auth-abuse against a
  backend) than a static bundle served read-only from S3. A CloudFront-scope WAF web ACL can be
  added later (`aws_wafv2_web_acl` with `scope = "CLOUDFRONT"`, associated via
  `aws_cloudfront_distribution.web_acl_id`) if a real requirement for one shows up; none is in this
  ticket's acceptance criteria.
- **It does not run in `dev`.** The root module only instantiates `module.cdn` for `staging` and
  `prod` (`count` in `infra/terraform/main.tf`) — the ticket's own description says "staging/prod
  origins", and dev's `web_origin` is `http://localhost:5173` (the Vite dev server), which has
  nothing to put behind a CDN.

## Topology

```
route53_zone_id (existing) ──alias A──► aws_cloudfront_distribution.this
                                                       │
                          ┌────────────────────────────┴────────────────────────────┐
                          │                                                          │
              default_cache_behavior (*)                        ordered_cache_behavior (assets/*)
              cache_policy: html_no_cache (TTL 0)                cache_policy: immutable_assets (TTL 1y)
              headers: Cache-Control: no-cache                   headers: Cache-Control: public, max-age=1y, immutable
                          │                                                          │
                          └────────────────────────────┬────────────────────────────┘
                                                          ▼
                                    origin: aws_s3_bucket.web_bundle (private, OAC-only)
                                                          ▲
                                          aws_iam_role.deploy (GitHub OIDC,
                                          environment-scoped) — s3 sync + CreateInvalidation
```

## The two cache classes

| Class                        | Path pattern (`immutable_asset_path_pattern`)                                                                 | CloudFront cache policy TTL                                                           | Response `Cache-Control`              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| Immutable static assets      | `assets/*` (Vite's actual default output dir — `apps/web/vite.config.ts` takes no `build.assetsDir` override) | `immutable_asset_max_age_seconds` (default `31536000`, 1 year), fixed min=default=max | `public, max-age=31536000, immutable` |
| Everything else (HTML, root) | default behavior (`*`)                                                                                        | `0`                                                                                   | `no-cache`                            |

TTL `0` on the default behavior means every request is a cache **miss** forwarded to the origin —
a new deploy is visible on the very next request, which is what makes "deploy busts HTML instantly"
true independent of whether an invalidation call ever runs. The `assets/*` pattern relies on Vite's
content-hashed filenames (`app.a1b2c3d4.js`) never being overwritten in place; a filename is either
new (cache miss, fetched once) or unchanged (already cached) — there is never a stale-content case
to invalidate for that class, which is why `deploy.tf`'s invalidation targets HTML/root paths, not
`assets/*`.

## SPA fallback

`custom_error_response` maps CloudFront's `403` (private-bucket, OAC's response for a missing key)
and `404` to a `200` response serving `/index.html`. apps/web is a client-side-routed SPA
(`react-router-dom` in `apps/web/package.json`) — a deep-link refresh (e.g. `/courses/42`) has no
matching S3 object and must fall through to the app shell rather than a CDN error page.

## Usage

```hcl
module "cdn" {
  source = "./modules/cdn"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix              = module.naming.name_prefix
  environment               = var.environment
  domain_name               = var.cdn_domain_name
  route53_zone_id           = data.terraform_remote_state.bootstrap.outputs.route53_zone_id
  github_oidc_provider_arn  = module.registry.github_oidc_provider_arn
}
```

`aws.us_east_1` is a second, aliased `aws` provider the root module configures purely for this
module's ACM certificate — CloudFront only accepts certificates from `us-east-1`, regardless of
where the rest of the stack lives (`eu-central-1`). See `versions.tf`'s `configuration_aliases`.

## Verifying the acceptance criteria

```bash
# Long-cache immutable assets — pick any hashed filename from a build:
curl -sI "https://$(terraform output -raw cdn_domain_name)/assets/<file>.js" | grep -i cache-control
# expect: cache-control: public, max-age=31536000, immutable

# HTML no-cache:
curl -sI "https://$(terraform output -raw cdn_domain_name)/index.html" | grep -i cache-control
# expect: cache-control: no-cache

# Cache-hit ratio: CloudFront -> the distribution -> Monitoring tab in the console, or
aws cloudfront get-distribution --id "$(terraform output -raw cdn_distribution_id)" \
  --query 'Distribution.Status'
# Real cache-hit-ratio numbers require actual staging traffic to accumulate first — there is no
# synthetic way to fake a >90% ratio from a cold distribution; run this after staging traffic flows.

# Deploy busts HTML instantly (no invalidation needed for this to be true, TTL is 0):
curl -sI "https://$(terraform output -raw cdn_domain_name)/index.html" | grep -i x-cache
# expect: x-cache: Miss from cloudfront, on every single request
```

## Deploy role usage

See `docs/runbooks/cdn-cache-policy.md` for the full sync + invalidate command sequence a deploy
job runs after assuming `deploy_role_arn`.

## Inputs

| Name                                 | Type     | Default                    | Description                                                                                  |
| ------------------------------------ | -------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `name_prefix`                        | `string` | —                          | Resource name prefix, from `module.naming.name_prefix`.                                      |
| `environment`                        | `string` | —                          | Scopes `deploy`'s trust to the same-named GitHub Environment.                                |
| `domain_name`                        | `string` | —                          | Public hostname, e.g. `app.studafy.com`. Matches the host portion of `var.web_origin`.       |
| `route53_zone_id`                    | `string` | —                          | Existing public hosted zone ID, from the shared bootstrap stack.                              |
| `create_dns_record`                  | `bool`   | `true`                     | Alias `domain_name` at the distribution. Set `false` if DNS is managed elsewhere.            |
| `github_oidc_provider_arn`           | `string` | —                          | `module.registry.github_oidc_provider_arn` — this module reuses it, never creates a second.  |
| `github_repository`                  | `string` | `"yousefomar3003/studafy"` | `<owner>/<repo>` allowed to assume `deploy` via OIDC.                                        |
| `immutable_asset_path_pattern`       | `string` | `"assets/*"`               | CloudFront path pattern for the long-cache behavior. Vite's actual default output dir.       |
| `immutable_asset_max_age_seconds`    | `number` | `31536000`                 | TTL and `max-age` for the immutable-asset class. 1 year.                                     |
| `price_class`                        | `string` | `"PriceClass_100"`         | CloudFront edge-location tier. No researched traffic-geography requirement exists yet.       |
| `enable_deletion_protection`         | `bool`   | `false`                    | `retain_on_delete` on the distribution. Override `true` in `prod.tfvars`.                    |
| `force_destroy_bucket`               | `bool`   | `false`                    | Allow `terraform destroy` to remove a non-empty web-bundle bucket. Keep `false` outside dev. |
| `noncurrent_version_expiration_days` | `number` | `30`                       | Cleanup for the web-bundle bucket's version history.                                         |

## Outputs

| Name                       | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `web_bundle_bucket_id`     | Name of the private origin bucket. Deploy target for `aws s3 sync`.  |
| `web_bundle_bucket_arn`    | ARN of the origin bucket.                                            |
| `distribution_id`          | Pass to `aws cloudfront create-invalidation --distribution-id`.      |
| `distribution_arn`         | ARN of the distribution.                                             |
| `distribution_domain_name` | Default `*.cloudfront.net` domain, regardless of DNS setup.          |
| `domain_name`              | Echoes the input.                                                    |
| `certificate_arn`          | The validated ACM certificate (us-east-1) bound to the distribution. |
| `deploy_role_arn`          | Assume via OIDC in the deploy job for this environment.              |
