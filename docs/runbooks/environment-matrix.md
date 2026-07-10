# Environment matrix

What differs between `dev`, `staging` and `prod`, and the exact runbook to take an environment
from `terraform apply` to a verified, running state — including the ERPNext + Frappe Education
plane. One root Terraform module, three thin overlays (ADR-004); this doc is the reference for
what each overlay actually sets, not a fourth copy of the configuration.

**Honesty note:** every value below reflects what this repo's Terraform/deploy code is written to
produce. None of it has been applied against a real AWS account from this repo's own
authoring environment — no AWS credentials were available. "Apply-ready" means `terraform fmt`,
`terraform validate`, and an offline `plan` (see `infra/terraform/README.md`'s local-backend-override
trick) all pass; it does not mean a real environment is currently running.

## Network

| Environment | `vpc_cidr`    | `az_count` | `single_nat_gateway`  | State bucket              |
| ----------- | ------------- | ---------- | --------------------- | ------------------------- |
| dev         | `10.0.0.0/16` | 2          | `true` (cost over HA) | `studafy-tfstate-dev`     |
| staging     | `10.1.0.0/16` | 2          | `true` (cost over HA) | `studafy-tfstate-staging` |
| prod        | `10.2.0.0/16` | 3          | `false` (one NAT/AZ)  | `studafy-tfstate-prod`    |

Full subnet/security-group topology: `docs/runbooks/network-diagram.md`.

## Data tier

| Resource                         | dev                   | staging           | prod                                                                 |
| -------------------------------- | --------------------- | ----------------- | -------------------------------------------------------------------- |
| Postgres instance class          | `db.t4g.micro`        | `db.t4g.micro`    | `db.t4g.micro` (unresearched sizing everywhere — see `variables.tf`) |
| Postgres deletion protection     | `false`               | `false`           | `true`                                                               |
| Redis node type                  | `cache.t4g.micro`     | `cache.t4g.micro` | `cache.t4g.micro`                                                    |
| MariaDB instance class (ERPNext) | n/a — not provisioned | `db.t4g.micro`    | `db.t4g.micro`                                                       |
| MariaDB deletion protection      | n/a                   | `false`           | `true`                                                               |

## Edge / DNS

| Environment | `edge_domain_name`        | `cdn_domain_name`                                          | `web_origin`                              | `edge_idle_timeout` | `dns_manage_zone`           |
| ----------- | ------------------------- | ---------------------------------------------------------- | ----------------------------------------- | ------------------- | --------------------------- |
| dev         | `dev-api.studafy.com`     | `dev.studafy.com` (unused — `module.cdn` not instantiated) | `http://localhost:5173` (Vite dev server) | `60` (default)      | `false` (reads prod's zone) |
| staging     | `staging-api.studafy.com` | `staging.studafy.com`                                      | `https://staging.studafy.com`             | `3600`              | `false` (reads prod's zone) |
| prod        | `api.studafy.com`         | `app.studafy.com`                                          | `https://app.studafy.com`                 | `3600`              | `true` (owns the zone)      |

`edge_idle_timeout` was raised from `modules/edge`'s own `60`s default to `3600`s in staging/prod
once `apps/realtime`'s `/ws` route shared the same ALB (`modules/compute`'s listener rule) — an
idle-but-open WebSocket would otherwise be cut mid-session. dev keeps the default; nothing there
exercises a long-lived connection today.

## Compute tier (`modules/compute` — every environment)

| Setting                                                                                         | dev | staging | prod                                                                        |
| ----------------------------------------------------------------------------------------------- | --- | ------- | --------------------------------------------------------------------------- |
| `API_DESIRED_COUNT`                                                                             | 1   | 2       | 2 (see `infra/deploy/environments/prod.env` for the actual committed value) |
| `API_MIN_HEALTHY_PERCENT`                                                                       | 50  | 100     | 100                                                                         |
| Same pattern for `REALTIME_*`/`WORKERS_*` — see `infra/deploy/environments/<env>.env` directly. |

The cluster, execution role, and `api`/`realtime` target groups exist identically in all three —
only the deploy-time replica counts and rolling-update thresholds differ, and those live in
`infra/deploy/environments/*.env`, not Terraform.

## ERPNext + Frappe Education plane (`modules/mariadb`, `modules/erpnext` — staging/prod only)

| Setting         | dev                                        | staging                                                  | prod                                                         |
| --------------- | ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------ |
| Instantiated?   | No (`local.erpnext_plane_enabled = false`) | Yes                                                      | Yes                                                          |
| Public exposure | n/a                                        | None — internal ALB only, reachable only from `apps/api` | Same                                                         |
| Seed tenant     | n/a                                        | Yes — see "Runbook" below                                | No — seeding is a staging/test concept, not run against prod |

## Runbook: apply to verified

Run from `infra/terraform/`, substituting `staging` for `<env>` as needed. This is the operator
sequence this ticket's Terraform/scripts are written to support — not something that has been run
for real from this repo's own authoring environment (see the honesty note at the top).

1. **Bootstrap the state bucket** (one-time, out of band — see `infra/terraform/README.md`'s
   "Backend setup"): `aws s3api create-bucket --bucket studafy-tfstate-staging ...`.
2. **Init and apply:**
   ```bash
   terraform init -reconfigure -backend-config=environments/staging/backend.hcl
   terraform apply -var-file=environments/staging/staging.tfvars
   # TF_VAR_bastion_allowed_ssh_cidrs, TF_VAR_bastion_key_name, TF_VAR_secrets_app_secret_values
   # must be exported first — see infra/terraform/README.md.
   ```
3. **Populate the deploy-time env file:**
   ```bash
   ../deploy/scripts/populate-env.sh staging
   ```
4. **Build, push, sign and deploy `api`/`realtime`/`workers`** (per
   `docs/runbooks/supply-chain-security.md` and `infra/docker/README.md`):
   ```bash
   docker build -f ../docker/api.Dockerfile -t "$DIGEST_TAG" .
   docker push "$DIGEST_TAG"
   cosign sign --key "awskms:///$(terraform output -raw registry_signing_key_alias)" --yes "$DIGEST_TAG"
   ../deploy/scripts/deploy.sh api staging "$IMAGE_TAG"
   # repeat for realtime, workers
   ```
5. **Build, push, sign and deploy the ERPNext plane's image:**
   ```bash
   docker build -f ../docker/erpnext.Dockerfile -t "$ERPNEXT_DIGEST_TAG" .
   docker push "$ERPNEXT_DIGEST_TAG"
   cosign sign --key "awskms:///$(terraform output -raw registry_signing_key_alias)" --yes "$ERPNEXT_DIGEST_TAG"
   # bump erpnext_image_tag in staging.tfvars (or TF_VAR_erpnext_image_tag) to the new tag, then
   # re-apply — modules/erpnext's aws_ecs_service resources pick it up directly, no deploy.sh
   # equivalent (see modules/erpnext/README.md's "no rolling zero-downtime deploy" known gap).
   terraform apply -var-file=environments/staging/staging.tfvars
   ```
6. **Create and seed the tenant:**
   ```bash
   ../deploy/scripts/erpnext-new-site.sh staging seed-school.erpnext.staging.studafy.com --seed
   ```
7. **Verify each acceptance criterion:**
   - _All services healthy in staging_: `aws ecs describe-services --cluster
$(terraform output -raw compute_ecs_cluster_name) --services <name>` for each of
     api/realtime/workers, and again for each value in `terraform output -json
erpnext_cluster_service_names` (the five ERPNext services).
   - _ERPNext plane reachable only from the integration gateway_: from the bastion (which is
     **not** in the `app` security group), `curl` `$(terraform output -raw erpnext_internal_alb_dns_name)`
     should time out or be refused; from an `apps/api` task (via `aws ecs execute-command`), the
     same `curl` against `/api/method/ping` should return `200 {"message":"pong"}`.
   - _Seed tenant usable end-to-end_: `curl` the internal ALB with `Host:
seed-school.erpnext.staging.studafy.com`, confirm a Frappe login page renders, and confirm the
     `Test Student One`/`Test Student Two` records exist (`infra/deploy/erpnext/seed/README.md`).
   - _Staging isolated from prod data and keys_: separate state buckets, separate VPCs
     (non-overlapping CIDRs), separate Secrets Manager containers per environment (`name_prefix`
     scoped) — structurally true by this repo's own module design, not something to check
     per-deploy.
   - _Staging DNS and certificates_: `dig staging-api.studafy.com` resolves to the ALB, `dig
staging.studafy.com` resolves to the CloudFront distribution, `curl -v
https://staging-api.studafy.com/healthz` presents a valid ACM certificate.
