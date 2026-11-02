# `erpnext`

ERPNext + Frappe Education plane: EFS-backed bench, five ECS Fargate services, and an internal
(VPC-only) ALB — `apps/api` is the plane's only caller ("the integration gateway"), enforced by the
`erpnext` security group's ingress rule (`modules/network`), not by anything in this module. See
[`docs/adr/0005-erpnext-education-plane.md`](../../../../docs/adr/0005-erpnext-education-plane.md)
for the full set of decisions and alternatives this module implements.

## Site-per-school

Frappe's own multi-tenancy primitive is a "site" — one MariaDB database, one set of
`site_config.json`/private-files under `sites/<hostname>/`, addressed by the `Host` header. This
module provisions the shared bench (compute + the EFS volume every role mounts identically); it
does **not** create any school's site. That happens after `apply`, via
`infra/deploy/scripts/erpnext-new-site.sh <env> <hostname>`, which runs this module's
`site_setup_task_definition_arn` with an overridden `bench new-site ... --install-app erpnext
--install-app education` command — the concrete mechanism behind the ticket's "seed tenant usable
end-to-end" criterion.

## Why an internal ALB, not Service Connect, for apps/api

Cloud Map / ECS Service Connect was the first design considered for `apps/api -> erpnext-frontend`.
It doesn't work without also editing `apps/api`'s own ECS service definition
(`infra/deploy/ecs/api/service.json.tpl`, a different ticket's already-closed deliverable) to join
the same namespace — Service Connect's DNS resolution only works for tasks that are themselves
configured with `serviceConnectConfiguration`, on both ends. An internal ALB has no such
requirement: any task the `erpnext` security group allows can reach it by its ordinary
AWS-assigned DNS name (`internal_alb_dns_name`), automatically resolvable in-VPC, no Route 53
record needed. Service Connect is still used _inside_ this module — `frontend`'s nginx role
resolves `erpnext-backend`/`erpnext-websocket` — because all three of those services are owned
here, so there's no cross-ticket edit required for that hop.

## Topology

| Resource                                                      | Count                                        | Purpose                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws_efs_file_system`                                         | 1                                            | The shared `sites` directory. Encrypted at rest.                                                                                                                                                                                                                                                                         |
| `aws_efs_access_point`                                        | 1                                            | uid/gid 1000 (frappe_docker's documented container user), root at `/sites`.                                                                                                                                                                                                                                              |
| `aws_efs_mount_target`                                        | one per `private_app_subnet_id`              | In the `erpnext` security group.                                                                                                                                                                                                                                                                                         |
| `aws_service_discovery_http_namespace`                        | 1                                            | Service Connect namespace, internal to this module (frontend -> backend/websocket only).                                                                                                                                                                                                                                 |
| `aws_ecs_task_definition`/`aws_ecs_service`                   | `backend`, `websocket`, `queue`, `scheduler` | Same image (`infra/docker/erpnext.Dockerfile`), differ only in command. `queue` is one combined worker across short/default/long RQ priorities (KISS — staging doesn't need three services). `scheduler`'s `desired_count` is fixed at 1, not a variable — concurrent `bench schedule` runs would double-fire cron jobs. |
| `aws_ecs_task_definition.frontend`/`aws_ecs_service.frontend` | 1                                            | Stock upstream `frappe/erpnext-nginx` image — it proxies HTTP, it doesn't run bench, so it doesn't need the Education app this repo's own image adds. Behind the internal ALB.                                                                                                                                           |
| `aws_ecs_task_definition.site_setup`                          | 1 (no service)                               | Inert — registered but never auto-launched. `erpnext-new-site.sh` runs it via `aws ecs run-task` with an overridden command.                                                                                                                                                                                             |
| `aws_lb.internal` + target group + listener                   | 1                                            | Internal ALB, plain HTTP (see "Known gaps"), health check `/api/method/ping` (Frappe's unauthenticated liveness endpoint — works before any site exists).                                                                                                                                                                |
| `aws_cloudwatch_log_group`                                    | 6                                            | One per role, explicit retention.                                                                                                                                                                                                                                                                                        |

## What this module does not do

- **It does not create MariaDB or the erpnext/mariadb/redis security groups.** Those are
  `modules/mariadb` and `modules/network` — this module only consumes their outputs.
- **It does not generate `ADMIN_PASSWORD`/`ENCRYPTION_KEY`.** Those live in `module.secrets`'s
  `erpnext` app-secrets container (`${name_prefix}/erpnext/app-secrets`) — generated at the root
  module and fed into `module.secrets`'s `app_secret_values`, not duplicated here. A second
  `aws_secretsmanager_secret` in this module at the same canonical path would collide with the one
  `module.secrets` already creates for every `services` map entry.
- **It creates no task role.** Same reasoning as `modules/compute`'s README — no service here calls
  the AWS SDK from application code; EFS access is POSIX+security-group enforced
  (`authorization_config.iam = "DISABLED"`), not IAM-per-mount.

## Usage

```hcl
module "erpnext" {
  source = "./modules/erpnext"
  count  = var.environment == "dev" ? 0 : 1

  name_prefix         = module.naming.name_prefix
  aws_region          = var.aws_region
  vpc_id              = module.network.vpc_id
  cluster_arn         = module.compute.cluster_arn
  execution_role_arn  = module.compute.execution_role_arn

  private_app_subnet_ids = module.network.private_app_subnet_ids
  security_group_id      = module.network.erpnext_security_group_id

  image_repository_url = module.registry.repository_urls["erpnext"]
  image_tag             = var.erpnext_image_tag

  mariadb_address                = module.mariadb[0].address
  mariadb_connection_secret_arn  = module.mariadb[0].connection_secret_arn
  redis_primary_endpoint_address = module.redis.primary_endpoint_address
  redis_auth_secret_arn          = module.redis.auth_secret_arn
  erpnext_secret_arn             = module.secrets.service_secret_arns["erpnext"]
}
```

The frontend role never hardcodes a site hostname (`FRAPPE_SITE_NAME_HEADER` is the literal string
`$host`, not a Terraform variable) — that's what makes site-per-school work: nginx passes through
whichever `Host` header the caller sent, and bench resolves the matching site per request. Only
`infra/deploy/scripts/erpnext-new-site.sh <env> <hostname>` needs to name a specific hostname, at
the moment it creates that one school's site.

## Known gaps

- **No TLS between the internal ALB and the frontend service, or between apps/api and the ALB.**
  Plain HTTP, relying on the erpnext security group and the VPC boundary itself — a deliberate
  simplification for a plane with no public exposure at all, unlike `modules/pgbouncer`'s
  self-signed-cert precedent for a similarly internal-only service. Revisit if a compliance
  requirement demands encryption-in-transit even within the VPC.
- **No rolling zero-downtime deploy.** Bumping `image_tag` and re-applying replaces tasks the way
  any `aws_ecs_service` update does (Terraform's own default `ECS` deployment controller, no
  circuit breaker configured here) — there is no `deploy.sh`-equivalent script for this plane. This
  is an accepted trade-off for a low-traffic internal ERP plane, not attempted here; see
  `docs/adr/0005-erpnext-education-plane.md`.
- **Exact `frappe_docker` environment-variable names are asserted, not verified against a real
  build.** `BACKEND`/`SOCKETIO`/`DB_HOST`/`REDIS_CACHE`/`REDIS_QUEUE` etc. follow the documented
  contract for the pinned image version at authoring time — confirm against
  `infra/docker/erpnext.Dockerfile`'s actual pinned tag before a real deploy, same
  "not exercised against a live account" caveat every module in this repo not yet applied carries.
- **`aws_efs_backup_policy` is not enabled.** MariaDB gets automated RDS backups
  (`modules/mariadb`'s `backup_retention_days`); the EFS `sites` volume (uploaded files, site
  configs) does not have an equivalent backup wired here.

## Inputs / Outputs

See `variables.tf`/`outputs.tf` — every input has a `description`; not duplicated here to avoid two
sources of truth drifting (this module's variable count is large enough that a hand-maintained
table would go stale quickly, unlike the smaller modules elsewhere in this repo).
