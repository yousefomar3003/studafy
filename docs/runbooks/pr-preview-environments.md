# PR preview environments

Ephemeral, per-pull-request previews: the `apps/web` bundle plus `apps/api`, running as one ECS
Fargate task, reachable at `http://pr-<number>.<preview-domain>:8080`, backed by an isolated
`preview_pr_<number>` database on a shared preview Postgres server with the demo tenant seeded
into it. Built by [`.github/workflows/pr-preview.yml`](../../.github/workflows/pr-preview.yml),
removed by
[`.github/workflows/pr-preview-teardown.yml`](../../.github/workflows/pr-preview-teardown.yml).

## Status

**Not runnable yet — the preview layer it targets is not provisioned.** This is the same shape
`docs/runbooks/deploy-rollback.md` was in before `modules/compute` landed: the workflows, scripts
and task definition are written to be correct once the layer exists, and are held inert until then
by two independent guards —

- `pr-preview.yml`'s `guard` job requires `vars.AWS_DEPLOYMENTS_ENABLED == 'true'` (the same repo
  variable every other deploy workflow keys off) **and** the PR to carry a `preview` label. Every
  other PR event still runs the `build` / `database` / `deploy` jobs, but their real steps are
  `if`-gated on that eligibility — so they finish green in a few seconds with a one-line reason in
  the log, rather than showing as four "Skipped" checks on every unrelated PR;
- the eleven `PREVIEW_*` handles in
  [`infra/deploy/environments/preview.env`](../../infra/deploy/environments/preview.env) are blank,
  and `preview-up.sh` / `preview-down.sh` exit early on any empty one.

Nothing here has been run against a real AWS account from this repo's authoring environment. What
_was_ exercised: `bash -n` on every script, `prettier --check`, the rendered-JSON assertions in
[`infra/deploy/preview/task-definition.test.ts`](../../infra/deploy/preview/task-definition.test.ts),
and a local dry-run of the `envsubst` render and the `turbo run build --filter=@studafy/web` plan.
`actionlint` and `shellcheck` were not available in the authoring environment and have not been
run — the same caveat `infra/deploy/README.md`'s "Known gaps" carries for `deploy.sh`.

## Why this shape (and not staging's)

`staging-deploy.yml` builds signed images and rolls a load-balanced ECS **service** with health
gates and auto-rollback. A preview does not need any of that, and paying for it per PR would blow
the "preview URL in under 8 minutes" budget. The deliberate reductions:

| Staging                                                                                                           | Preview                                                      | Why                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALB + target group + listener rule + ACM cert                                                                     | ENI public IP, `http` on `:8080`                             | No per-PR load balancer to create and delete; teardown is `stop-task`. The cost is a port in the URL and no TLS.                                           |
| cosign-signed images, per-env registry + KMS key                                                                  | unsigned images in a `studafy-preview` registry              | A preview runs unmerged code; signing it with the production key would weaken what a signature means. The registry is isolated.                            |
| `NODE_ENV=production`, PgBouncer, TLS, `DATABASE_CA_CERT`, `READ_DATABASE_*`, `CORS_ALLOWED_ORIGINS` all required | `NODE_ENV=development`, direct connection, `sslmode=disable` | Lets the API boot against a plain per-PR database without the full production env contract. A preview is a functional check, not a production rehearsal.   |
| Shared RDS Multi-AZ                                                                                               | One shared **non-RDS** Postgres, one database per PR         | `db/seeds/guard.ts` hard-refuses to seed against an RDS/staging/prod host. A per-PR database (not a schema) works with `db:migrate` / `db:seed` unchanged. |
| ECS **service** (desired-count, rolling update)                                                                   | ECS **run-task** (one task, no controller)                   | Same mechanism `migrate.sh` already uses. Nothing here needs replicas or a zero-downtime rollout.                                                          |

## Architecture

```
pull_request (labeled `preview`, same repo, deployments enabled)
        │
        ├─ build     ── docker build+push  studafy-preview/api:<tag>   (infra/docker/api.Dockerfile)
        │              turbo build @studafy/web  (VITE_API_BASE_URL=/api)
        │              docker build+push  studafy-preview/web:<tag>    (infra/deploy/preview/web.Dockerfile)
        │
        ├─ database   ── preview-db.sh create  → DROP/CREATE preview_pr_<n>
        │              bun run db:migrate       (DATABASE_URL → preview_pr_<n>, sslmode=disable)
        │              bun run db:seed          (SEED_ALLOW_NONLOCAL=true)
        │
        └─ deploy     ── preview-up.sh:
                          register task def (api + web containers, one task)
                          run-task  (FARGATE, public subnet, assignPublicIp=ENABLED, started-by studafy-preview-pr-<n>)
                          resolve ENI public IP → route53 UPSERT  pr-<n>.<domain> A <ip>
                          poll  http://…:8080/healthz  and  /api/healthz  until 200
                        → sticky PR comment with the URL
```

`build` and `database` run in parallel (both only `needs: guard`); `deploy` waits for both. The
web bundle is built with `VITE_API_BASE_URL=/api` so the SPA calls its own origin, which
`infra/deploy/preview/nginx.conf` reverse-proxies to the co-located `api` container on loopback —
no CORS configuration on the API, and only one port (`8080`, the `web` container) is published.

Teardown, on `pull_request: closed`, runs `preview-down.sh`: stop the task(s), delete the DNS
record, drop the database, deregister the task-definition revisions, then **re-check the first
three and exit non-zero on any residue** — that failing exit is the "teardown verified" gate.
An hourly `schedule` sweep in the same workflow stops any preview task older than
`PREVIEW_TASK_TTL_HOURS` (default 72), covering a missed close event and capping how long a
forgotten preview can bill.

## Prerequisites

### One-time, out of band (like the tfstate buckets)

Two ECR repositories under the preview registry:

```bash
aws ecr create-repository --repository-name studafy-preview/api --region eu-central-1
aws ecr create-repository --repository-name studafy-preview/web --region eu-central-1
# A lifecycle policy that expires untagged images after a few days keeps them from accreting.
```

### The preview layer (a future Terraform addition, not in this repo yet)

| Handle (`preview.env`)                        | What it is                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PREVIEW_ECR_REGISTRY`                        | Registry base, e.g. `<acct>.dkr.ecr.eu-central-1.amazonaws.com`                                |
| `PREVIEW_ECS_CLUSTER`                         | One shared ECS cluster for preview tasks                                                       |
| `PREVIEW_EXECUTION_ROLE_ARN`                  | Task execution role: ECR pull from the two repos + `logs:CreateLogGroup`/`PutLogEvents`        |
| `PREVIEW_SUBNET_ID`                           | A **public** subnet (tasks get a public IP and are reached on it directly)                     |
| `PREVIEW_SECURITY_GROUP_ID`                   | Allows inbound `tcp/8080` from `PREVIEW_INGRESS_CIDRS`; all egress                             |
| `PREVIEW_DNS_ZONE_ID` / `PREVIEW_BASE_DOMAIN` | Route 53 zone + apex for `pr-<n>.<domain>` A records                                           |
| `PREVIEW_DB_HOST` / `PREVIEW_DB_PORT`         | The shared preview Postgres — **not RDS, no staging/prod in the hostname** (see below)         |
| `PREVIEW_DB_SECRET_ARN`                       | Secrets Manager secret with `username` / `password` keys for the role the ECS task connects as |

### GitHub Actions configuration

| Kind     | Name                         | Value                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variable | `AWS_DEPLOYMENTS_ENABLED`    | `true` to arm previews (shared with every other deploy workflow)                                                                                                                                                                                                                                                                                                                                            |
| variable | `AWS_PREVIEW_ROLE_ARN`       | OIDC role: ECR push, `ecs:RegisterTaskDefinition`/`RunTask`/`StopTask`/`DescribeTasks`/`ListTasks`/`DeregisterTaskDefinition`, `ec2:DescribeNetworkInterfaces`, `route53:ChangeResourceRecordSets`+`ListResourceRecordSets` on the preview zone. May start as the value of `AWS_APPLY_ROLE_ARN` (broader than needed) the way `staging-deploy.yml` reuses it today; least-privilege scoping is a follow-up. |
| secret   | `PREVIEW_DATABASE_ADMIN_URL` | `postgresql://<admin>:<pw>@<PREVIEW_DB_HOST>:<port>/postgres` — used by the runner to create/drop/migrate/seed per-PR databases. Its password is auto-masked in logs.                                                                                                                                                                                                                                       |
| label    | `preview`                    | Add it to a PR to build a preview; remove it and close/reopen to stop future builds.                                                                                                                                                                                                                                                                                                                        |

### The shared preview Postgres must not be RDS

`db/seeds/guard.ts` throws `SeedSafetyError` — with no override — for any host matching
`/rds\.amazonaws\.com$/`, `/\.rds\./`, or a `staging`/`prod`/`preprod`-shaped name. So a
`preview_pr_<n>` database on RDS could be migrated but never seeded, and the acceptance criterion
"seeded demo tenant" would be unmeetable. Use a self-managed Postgres 13+ (a small EC2 instance,
or a container) reachable at a neutral name such as `preview-db.studafy.internal`. `preview-up.sh`
passes `SEED_ALLOW_NONLOCAL=true`, which clears the non-loopback check but never the
RDS/staging/prod patterns.

## Acceptance criteria — how each is met and checked

**Preview URL posted on the PR in under 8 minutes.** `build` and `database` are parallel; the
API image builds with a registry cache (`--cache-from/--cache-to type=registry` in the preview
ECR); the web image is a `COPY` of an already-built `dist/` onto nginx (no `bun install`, no
`vite build` inside Docker). `deploy` then does a single `run-task` + one Route 53 UPSERT + a
health poll. Measure it on the `deploy` job's `up` step and the workflow's total duration; if the
image builds dominate, warm the cache by merging a no-op `preview`-labelled PR first, or raise the
Fargate CPU in `preview.env`.

**Teardown verified.** `preview-down.sh` ends by re-querying ECS (`list-tasks --started-by`),
Route 53 (`list-resource-record-sets`) and Postgres (`SELECT 1 FROM pg_database`) and exits
non-zero if any of the three still shows the preview — which reds `pr-preview-teardown.yml`. Run
it by hand for a spot check:

```bash
# after closing a PR, or via workflow_dispatch with pr_number
PREVIEW_DATABASE_ADMIN_URL=… bash infra/deploy/scripts/preview-down.sh <pr-number>
# exits 0 and prints "teardown verified for PR #<n>: no tasks, no DNS record, no database"
```

**Preview isolated from staging data.** Three structural boundaries, none of them per-deploy
checks:

- the preview Postgres is a **different server** from staging's RDS (different VPC, different
  credentials, different Secrets Manager container) — the same "separate state, separate VPC,
  separate secrets" argument `docs/runbooks/environment-matrix.md` makes for staging vs. prod;
- each PR gets its **own database** (`preview_pr_<n>`), so previews cannot see each other's rows;
- the seed guard makes it impossible for this workflow to point `db:seed` at staging even by
  misconfiguration — an RDS or `*staging*` host is a hard, unoverridable failure.

## Known gaps

1. **No authenticated preview.** `apps/api` "currently has no tenant domain handlers or
   authorization integration" (`apps/api/README.md`), so a preview shows the web app's
   public/marketing surface and whatever renders without a session. Wiring the mock IdP
   (`MOCK_OAUTH_ISSUER_URL` / `MOCK_OAUTH_REDIRECT_URI` on the `api` container, pointed at the
   preview host) is a deliberate follow-up — it would ship an auth path that has never been
   exercised against a deployed preview, which this ticket does not do silently.
2. **Plain `http`.** No per-preview ACM certificate; the URL carries `:8080`. A shared
   `*.preview.<domain>` wildcard cert on a shared preview ALB would fix both, at the cost of
   per-PR listener-rule create/delete in teardown — the alternative topology weighed in the
   ticket.
3. **`AWS_PREVIEW_ROLE_ARN` is over-broad** if set to `AWS_APPLY_ROLE_ARN`. Same known gap, and
   same fix (a dedicated scoped role), as `infra/deploy/README.md`'s "Known gaps" #5 for
   `deploy.sh`.
4. **Interim alerting only.** A failed preview build updates the sticky PR comment; there is no
   Slack/PagerDuty path, because none exists in this repo yet (`docs/runbooks/pgbouncer-conventions.md`
   flags the same gap). A failed teardown reds `pr-preview-teardown.yml`, which is the signal.
5. **Fork PRs get no preview.** They have no OIDC or secret access by GitHub's design, and this
   workflow does not use `pull_request_target`. A maintainer who wants a preview of a fork PR can
   push its branch to this repo.
