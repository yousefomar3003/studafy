# API reference site (ST-269)

The hosted, generated counterpart to this directory's hand-maintained docs. Source lives in
[`apps/docs-api`](../../apps/docs-api); this file is the pointer a reader lands on from `docs/api/`
itself.

## What it is

A static site with two halves:

- **API operations** — every endpoint, request, and response schema, generated straight from
  [`apps/api/openapi.json`](../../apps/api/openapi.json) via [Scalar](https://github.com/scalar/scalar)
  (`@scalar/client-side-rendering`'s `renderApiReference` — the exact function
  `apps/api/src/app.ts`'s local, dev-only `/docs` route already calls, so the two never drift into
  looking or behaving differently).
- **Guides** — four hand-authored pages: authentication, error handling, idempotency, and
  pagination. Each is real prose read off the code that enforces it
  ([`apps/docs-api/src/content`](../../apps/docs-api/src/content)), not paraphrased from this
  directory's other files, and every worked example that names a request or an error code is
  checked against the live contract in CI — see "Validation" below.

## Where it's deployed

One CloudFront distribution per environment, reusing `module.cdn`'s existing web-bundle bucket
under a `docs/api/` key prefix (see
[`docs/runbooks/cdn-cache-policy.md`](../runbooks/cdn-cache-policy.md)'s "A second site shares this
bucket"). `module.cdn` is not instantiated for `dev`, so the site deploys to staging and production
only:

| Environment | URL                                                      |
| ----------- | -------------------------------------------------------- |
| staging     | `https://staging.studafy.com/docs/api/latest/index.html` |
| production  | `https://app.studafy.com/docs/api/latest/index.html`     |

`latest/` always mirrors the most recently deployed release; every release additionally gets an
immutable copy at `docs/api/<commit-sha>/index.html` that stays addressable after `latest` moves on
— see `.github/workflows/staging-deploy.yml` and `prod-deploy.yml`'s `deploy-docs` job, which runs
on every release build (`needs: build`), independent of and in parallel with the api/realtime/workers
rolling deploy.

`index.html` in that URL is not decorative — link to it explicitly. A known caching limitation
(documented in cdn-cache-policy.md) means the bare directory URL falls through to apps/web's shell
instead of the docs site's.

## Building and testing it locally

```bash
bun run openapi:generate                 # apps/api/openapi.json — gitignored, regenerated on demand
bun run --cwd apps/docs-api build         # writes apps/docs-api/dist/
bun run --cwd apps/docs-api test          # unit tests + validates the real guides against the real spec
```

## Validation ("examples validated against spec in CI")

Every guide's `CodeBlock` can name the endpoint it calls (`api: { method, path, documented }`) and
the error codes its prose or JSON references (`errorCodes: [...]`) — see
[`apps/docs-api/src/content/types.ts`](../../apps/docs-api/src/content/types.ts). The build
(`apps/docs-api/src/build.ts`, via `validate.ts`) checks every one of those against the freshly
generated `apps/api/openapi.json` and `@studafy/constants`' `ERROR_CODES`, and fails with the exact
mismatch — not just "something's wrong" — if a guide names a path, method, or code that does not
exist. `.github/workflows/ci.yml`'s `quality` job runs this build unconditionally on every PR (not
gated behind the affected-package filter, for the same reason the `oasdiff`/benchmark steps
immediately above it aren't: this must catch a route or error-code change on the PR that makes it,
whether or not that PR also happens to touch `apps/docs-api`) and publishes the built site as the
`api-docs-site` build artifact.

## Auth quickstart, verified

The Authentication guide's curl-only quickstart drives the real mock-OAuth mobile exchange routes
(`GET /api/auth/oauth/mock/mobile-start`, `POST /api/auth/oauth/mock/mobile-exchange`) — the same
flow the Flutter integration suite (ST-247) automates end to end against the same mock provider —
rather than a flow invented for the guide. It needs `MOCK_OAUTH_ISSUER_URL` and
`MOCK_OAUTH_REDIRECT_URI` set locally (dev/test only; hard-disabled elsewhere, see
`apps/api/src/modules/auth/oauth/mock-config.ts`), which the guide states explicitly rather than
assuming.
