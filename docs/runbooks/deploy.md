# Runbook: production deploys (QA-005)

Production is released by **Production deploy (fly.io)**, `.github/workflows/fly-production-deploy.yml`, dispatched from the Actions tab **on `dev`**. By-hand `fly deploy` from a laptop is for emergencies only (see [infra/fly/README.md](../../infra/fly/README.md#deploying)).

## What the workflow guarantees

1. **Gate** (`scripts/deploy/verify-ci-green.sh`, its own job with no secrets): the run must be on `refs/heads/dev`, and the newest `CI` push run for that exact commit must have completed with `success`. Running, failed, cancelled or missing CI refuses the release. `stage` can't be released, because it carries the 000003 migration drift.
2. **Build once, scan, deploy by digest** (`scripts/deploy/release.sh`):
   - api, realtime, workers and web are each built once on Fly's builder and pushed;
   - each image's digest is resolved from the registry;
   - each image is scanned by Trivy at HIGH and CRITICAL, with fixed vulnerabilities only and `.trivyignore` waivers;
   - all of this happens **before** the scanner deploy and the migrations, so a vulnerable image changes nothing in production;
   - each service is then deployed with `--image <registry>@sha256:...`, the exact bytes that were scanned.
3. **Smoke** (`release.sh smoke`):
   - `api /readyz` must answer 200: database, Redis and storage reachable, not just a live process;
   - `web /healthz` must answer 200;
   - an anonymous `GET /api/auth/sessions` must answer 401, so the auth stack is up and not erroring;
   - five JWKS reads must agree on one `kid` set, so every machine shares `JWT_PRIVATE_KEY_PEM` (QA-023).
4. **Rollback:** if any step from the API deploy onward fails, every service is redeployed on the digest it ran before the workflow started (recorded at the top of the run). **Migrations aren't reverted.** They are forward-only, so a release must not ship a migration the previous code can't run against (expand, then contract).

## Server-side settings (NEEDS HUMAN, once)

The workflow file runs from the dispatched ref, so on its own it can't stop a modified copy on another branch. GitHub's environment settings can:

1. **Settings → Environments → `prod` → Deployment branches and tags**: choose "Selected branches and tags" and add **`dev` only**. Every `prod` secret is then unavailable to a run from any other ref.
2. **Required reviewers** on `prod`: at least one person other than the dispatcher. Turn on "Prevent self-review".
3. **Branch protection on `dev`**: require the `CI` checks and a pull request review, so `dev` only ever holds reviewed, green commits.
4. **Secrets**: `JWT_PRIVATE_KEY_PEM` must exist in `prod` before the first release that contains QA-023 ([rotation-jwt-jwks.md](security/rotation-jwt-jwks.md)). The deploy refuses to start without it.

## Still to decide (NEEDS HUMAN)

- **Authenticated synthetic check.** Sign-in is OIDC-only, so a true signed-in smoke call needs a dedicated synthetic identity, and its credential needs a home. Until then the smoke checks the auth surface (401) and the JWT key, not a signed-in request.

## Verifying the gate

Never against production. `bun test scripts/deploy` exercises both scripts against fake `gh`, `flyctl`, `docker` and `curl`, and asserts the workflow's structure. A live check: dispatch the workflow from a feature branch and expect the `gate` job to fail at the first step, before any secret is touched.
