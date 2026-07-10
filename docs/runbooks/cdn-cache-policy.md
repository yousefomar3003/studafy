# CDN cache policy note

Source of the resources this doc describes:
[`infra/terraform/modules/cdn`](../../infra/terraform/modules/cdn). That module provisions the
CloudFront distribution, its two cache classes, and the deploy role; this doc is why the cache
policy is shaped the way it is, and the exact deploy/verify commands a future CI workflow needs —
none of which exists yet (`infra/terraform/README.md`'s status note).

## Why two cache classes, not one

`vite build` (`apps/web`'s build tool, `apps/web/vite.config.ts`) writes two fundamentally
different kinds of file into `dist/`:

| File                                                 | Example           | Overwritten on redeploy?                                                                |
| ---------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| Content-hashed static assets, under `dist/assets/`   | `app.a1b2c3d4.js` | Never — a new build produces a new filename, the old one is simply no longer referenced |
| `dist/index.html` (and any other unhashed root file) | `index.html`      | Yes — every deploy overwrites the same filename with new content                        |

A single cache policy can't be correct for both: caching `index.html` for a year means users keep
seeing yesterday's app shell (which references yesterday's hashed asset filenames) for up to a
year after a deploy; never caching `app.a1b2c3d4.js` throws away the one guarantee its filename
already gives you — that URL will never point at different content, so there is nothing to
revalidate, ever.

`modules/cdn/distribution.tf` therefore has two `aws_cloudfront_cache_policy` /
`aws_cloudfront_response_headers_policy` pairs, split by `ordered_cache_behavior`'s path pattern:

| Path pattern (`var.immutable_asset_path_pattern`, default `assets/*`)  | TTL                                            | `Cache-Control` header                |
| ---------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| Matches (immutable assets)                                             | 1 year (`var.immutable_asset_max_age_seconds`) | `public, max-age=31536000, immutable` |
| Falls through to the default behavior (`*`) — HTML and everything else | 0                                              | `no-cache`                            |

Both the CloudFront-side TTL and the response header are set from the same module — not "TTL set
by Terraform, `Cache-Control` set by whatever the deploy script happens to write as S3 object
metadata" — because no build/deploy tooling exists yet in this repo to set that metadata correctly
(same "nothing built to set this yet" gap `modules/storage`'s README calls out for SSE-KMS). Until
something does, the cache behavior has to be self-contained in Terraform, not dependent on upload
discipline nobody has written yet.

## Why "no-cache" (not "no-store") is enough for instant busting

`no-cache` still permits a cache to store a response — it forbids serving it again without
revalidating with the origin first. Paired with the CloudFront cache policy's TTL `0` (every
request is a **miss**, forwarded straight to the S3 origin, not merely revalidated), the practical
effect is identical to `no-store` at the CDN edge: nothing is ever served from CloudFront's cache
for these paths. `no-cache` is what's requested in the header (a HTTP client, not just CloudFront,
should never serve a stale copy either) because "the deploy is visible on the next request" needs
to hold for a browser's own cache too, not only CloudFront's.

## Deploying: sync + invalidate

Once a `.github/workflows` file exists (none does yet — see "Known gaps" below) and CI assumes
`cdn_deploy_role_arn` for the target environment:

```bash
cd apps/web && bun run build   # writes dist/

BUCKET="$(terraform -chdir=infra/terraform output -raw cdn_web_bundle_bucket_id)"
DIST_ID="$(terraform -chdir=infra/terraform output -raw cdn_distribution_id)"

# --delete removes objects for files no longer in this build (e.g. assets from 3 deploys ago that
# nothing references anymore) — otherwise the bucket only grows.
aws s3 sync apps/web/dist "s3://$BUCKET" --delete

# Not strictly required for correctness — the html_no_cache cache policy's TTL 0 already means the
# very next request after this sync completes is a miss served from the new object. This
# invalidation exists for the ticket's explicit "invalidation hook" deliverable and as
# defense-in-depth against any cache this module doesn't control (a browser's own disk cache
# honoring a stale If-None-Match against the previous ETag, a corporate proxy, etc.) — scoped to
# root/HTML paths only, not assets/*, since content-hashed filenames never need invalidating (a
# filename either didn't exist before, or is unchanged).
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/" "/index.html"
```

## Verifying the acceptance criteria

```bash
DOMAIN="$(terraform -chdir=infra/terraform output -raw cdn_domain_name)"

# Immutable asset headers — substitute an actual hashed filename from a build:
curl -sI "https://$DOMAIN/assets/<file>.js" | grep -i cache-control
# expect: cache-control: public, max-age=31536000, immutable

# HTML no-cache:
curl -sI "https://$DOMAIN/index.html" | grep -i cache-control
# expect: cache-control: no-cache

# Deploy busts HTML instantly — x-cache should read "Miss from cloudfront" on every request, not
# just the first one after a deploy, because the cache policy's TTL is 0:
curl -sI "https://$DOMAIN/index.html" | grep -i x-cache

# SPA deep-link fallback (react-router-dom client-side routing):
curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/some/client-side/route"
# expect: 200 (custom_error_response maps CloudFront's 403/404 to a 200 index.html)
```

`>90% cache-hit ratio on static assets in staging` cannot be verified from a cold distribution —
CloudFront has no traffic to compute a ratio from yet. Check it from the CloudFront console's
Monitoring tab (or `aws cloudwatch get-metric-statistics --namespace AWS/CloudFront --metric-name
CacheHitRate`) after real staging traffic has flowed through `assets/*` for a while. A near-100%
ratio is the expected steady state given the TTL is fixed at a year and the underlying files never
change in place — a low number would point at something serving assets outside the `assets/*`
pattern (this module's `immutable_asset_path_pattern` variable exists specifically so that pattern
can be corrected without editing the module if `apps/web`'s build output layout ever changes).

## Known gaps

- No `.github/workflows` file wires the sync+invalidate sequence above into CI yet — same status
  as `modules/registry`'s known gaps. `cdn_deploy_role_arn`, `cdn_web_bundle_bucket_id` and
  `cdn_distribution_id` are the three outputs that workflow will need once it's written, a
  separate CI-scoped ticket.
- `modules/cdn` is not instantiated for `dev` (`infra/terraform/main.tf`'s `count` on
  `module.cdn`) — dev serves `apps/web` from the local Vite dev server (`http://localhost:5173`,
  `dev.tfvars`'s `web_origin`), not a deployed bundle, so there is nothing to put a CDN in front of
  there yet.
