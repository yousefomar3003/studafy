# ADR-005: ERPNext + Frappe Education plane for staging

## Status

Accepted

## Context

The staging-environment ticket ("Set up staging environment end to end") calls for a new plane
alongside the application stack ADR-004 already covers: "ERPNext + Frappe Education (Python/Frappe
on MariaDB, site-per-school) ... reachable only from the integration gateway." Nothing in this repo
— no module, no doc, no mention — referenced ERPNext, Frappe, MariaDB, or an "integration gateway"
before this ticket. Two decisions were escalated to the user rather than assumed, because nothing
in the codebase could resolve them:

- **What is the integration gateway?** `apps/api` is a bare health-check skeleton with no domain
  routes yet (`apps/api/README.md`) — there was no existing code path to point at. Resolved:
  `apps/api` is the integration gateway. The ERPNext plane's security group allows ingress only
  from `module.network.app_security_group_id`; nothing else (not the ALB, not the internet, not the
  bastion) can reach it.
- **Is the ECS compute tier (cluster/execution role/target groups) in scope here too?** It's a hard
  prerequisite for "all services healthy in staging" as written, but a previous ticket
  (`infra/deploy`, "author deploy manifests") explicitly deferred it to "a future compute-tier
  module." Resolved: build it now (`infra/terraform/modules/compute`) — see
  `infra/deploy/README.md`'s "Known gaps" #1-3, now closed.

This ADR covers the ERPNext-specific decisions only; the compute-tier decisions live implicitly in
`modules/compute`'s own README (no separate ADR — it's a direct, undisputed implementation of what
ADR-004 and `modules/edge/README.md` already committed to, not a new architectural fork).

## Decision

- **RDS MariaDB, not self-managed MariaDB on EC2.** `modules/mariadb` mirrors `modules/postgres`
  structurally (Multi-AZ HA pair, master credential in Secrets Manager, parameter group). Managed
  HA/patching/backups for the same reason `modules/postgres` chose RDS over self-managed Postgres —
  no new operational model to introduce for a second database engine.
- **One RDS instance holds many databases, not one per environment.** Frappe's own multi-tenancy
  primitive is a "site" — `bench new-site <school>` creates one MariaDB database per school at
  site-creation time, not at `terraform apply` time. This is the literal meaning of "site-per-school"
  in Frappe's own architecture, not a design choice this ticket invented.
- **ECS Fargate + EFS, not EKS or a second EC2 fleet.** Consistent with ADR-004/`infra/deploy`'s
  existing ECS decision — introducing Kubernetes for one plane while everything else is ECS would be
  "inventing infrastructure this repo has given no other indication it wants"
  (`infra/deploy/README.md`'s own words, about the exact same question for api/realtime/workers).
  EFS is the one new primitive: every bench role (backend/websocket/queue/scheduler/frontend) must
  mount the same `sites` directory identically — Fargate has no other way to share a writable
  filesystem across tasks.
- **An internal (VPC-only) ALB for apps/api -> erpnext-frontend, not ECS Service Connect end to
  end.** Service Connect was the first design (a Cloud Map namespace, `apps/api` resolving
  `erpnext-frontend` by DNS) — rejected once it became clear it requires _every_ caller to also
  join the namespace, including `apps/api`'s own ECS service, defined in a different ticket's
  already-closed deliverable (`infra/deploy/ecs/api/service.json.tpl`). An internal ALB needs zero
  changes there: any task the `erpnext` security group allows can reach it by its ordinary
  AWS-assigned DNS name. Service Connect is still used _inside_ `modules/erpnext` — `frontend`'s
  nginx role resolving `erpnext-backend`/`erpnext-websocket` — since those three services are all
  Terraform-owned in the same module, with no cross-ticket edit required.
- **Redis is reused, not duplicated.** Two new logical-DB slots (`2` = ERPNext cache, `3` = ERPNext
  queue) on the existing `module.redis` pair, extending
  `docs/runbooks/redis-conventions.md`'s DB-assignment table. A second Redis cluster would cost
  more and add another failover story for no isolation benefit `noeviction`-instance-wide semantics
  don't already provide equally well via DB separation.
- **A separate ECR repository and a custom `infra/docker/erpnext.Dockerfile`, not a bare pull of
  the upstream `frappe/erpnext` image.** The Education app isn't in the stock image; it has to be
  layered on via `bench get-app` at build time. Building it into this repo's own signed/scanned
  pipeline (cosign, `modules/registry`) keeps the same supply-chain posture every other image in
  this repo already has, rather than special-casing ERPNext as the one unsigned image pulled
  straight from Docker Hub. The `frontend` (nginx) role is the one exception — it runs the stock
  upstream `frappe/erpnext-nginx` image unmodified, since nginx doesn't run bench and doesn't need
  the Education app installed.
- **`erpnext` added to `module.secrets`'s `services` map**, exactly like `api`/`realtime`/
  `workers` — its own app-secrets container (`ADMIN_PASSWORD`, `ENCRYPTION_KEY`, both
  Terraform-`random_password`-generated at the root module) plus shared read access to
  `module.mariadb`'s and `module.redis`'s connection secrets.
- **staging and prod only, not dev** — `local.erpnext_plane_enabled` mirrors `module.cdn`'s
  existing `count = var.environment == "dev" ? 0 : 1` precedent. Dev has no need for it and no
  acceptance criterion asks for it there.

## Alternatives considered

- **A dedicated new "integration gateway" service.** Rejected: nothing in this repo indicates one
  should exist, and inventing a new service to satisfy a naming question in a ticket description
  would be exactly the kind of unrequested architecture this repo's own conventions warn against
  (see `infra/deploy/README.md`'s "Why not `apps/web`" for the same reasoning applied elsewhere).
  `apps/api` already is the one Studafy backend service; making it the gateway needs zero new code,
  only a security-group rule.
- **Self-hosted MariaDB on EC2 (mirroring `modules/pgbouncer`'s single-EC2-instance pattern).**
  Rejected: PgBouncer is a connection pooler, not a database — it has no HA/backup story of its own
  because Postgres itself provides that. MariaDB is the actual data store here; RDS's managed
  Multi-AZ failover and automated backups aren't optional the way they'd be for a pooler.
- **A second, ERPNext-dedicated Redis cluster.** Rejected — see "Decision" above. Revisit only if
  ERPNext's queue workload turns out to need a different eviction policy or fault-isolation
  boundary than the rest of this repo's Redis usage.
- **Splitting the ERPNext worker into three services (`queue-short`/`queue-default`/`queue-long`),
  the canonical `frappe_docker` layout.** Rejected for staging: one combined worker across all
  three RQ priorities. A low-traffic seed tenant doesn't need queue-priority isolation; three
  services would be three times the ECS/CloudWatch surface for no observed benefit yet (KISS).
  Revisit if real staging traffic shows queue contention.

## Consequences

- **The ERPNext plane has no rolling zero-downtime deploy.** Unlike `infra/deploy/scripts/
deploy.sh` (circuit-breaker-guarded rolling update for api/realtime/workers), bumping
  `erpnext_image_tag` and re-applying replaces ECS tasks the way any `aws_ecs_service` update does,
  with Terraform's default deployment controller. Accepted for a low-traffic internal ERP plane;
  revisit if this becomes a bottleneck.
- **No automatic MariaDB credential rotation.** `module.secrets`'s `rotation.tf` is wired
  specifically to Postgres's AWS-published rotation Lambda blueprint. AWS publishes an equivalent
  MariaDB blueprint if this becomes a real requirement — not wired here, since nothing in this
  ticket's acceptance criteria calls for it.
- **No TLS between the internal ALB and the frontend service.** Plain HTTP inside the VPC, relying
  on the `erpnext` security group and the internal ALB's own non-internet-facing placement.
  Revisit if a compliance requirement demands encryption-in-transit even within the VPC boundary.
- **`infra/docker/erpnext.Dockerfile` and the seed-fixture loader are unverified against a real
  build.** No AWS credentials and no container registry were available while authoring this —
  `terraform validate`/`fmt`/an offline `plan`, `bash -n` on the scripts, and JSON-shape checks on
  the templates are as far as verification goes. See `infra/terraform/modules/erpnext/README.md`'s
  "Known gaps" and `docs/runbooks/environment-matrix.md` for the exact commands an operator with
  real credentials runs next.
