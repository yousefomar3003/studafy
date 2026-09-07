# `monitoring`

CloudWatch alarms, the operations dashboard, the synthetic realtime probe (ST-149), and the
Prometheus/Grafana metrics stack (ST-259).

## Alarms & dashboard

All alarms are **action-free** (`alarm_actions = []` / `ok_actions = []`): notification ownership
is still to be agreed, so nobody gets paged for them yet. Their ARNs are collected in
`alarm_arns` for the day that lands.

The operations dashboard (`<prefix>-operations`) shows RDS CPU, Redis health, ECS service CPU/memory
and PostgreSQL replica lag, plus the probe's latency widget when the probe is enabled.

## Synthetic realtime probe

`probe_enabled = true` (staging/prod) provisions an EventBridge-scheduled Lambda
(`rate(1 minute)`) that measures the realtime propagation SLO end-to-end:

1. Connects a probe WebSocket client to the **public** ALB endpoint (`wss://…/ws`) — the real
   client path, DNS → ALB → TLS → gateway — signing its handshake JWT with `WS_JWT_SECRET`.
2. Once joined to its own user room (`school:probe:user:probe`), publishes a `synthetic.probe`
   envelope through Redis on that room's channel.
3. Measures the time until the envelope comes back over its own socket and publishes
   `RealtimeProbeLatency` (ms) to the `Studafy/Realtime` namespace.

Latency above `probe_slo_ms` (2000ms default) for 2 consecutive minutes, **or** a probe that stops
reporting (missing data is treated as breaching), fires `…-realtime-probe-latency-high`. Every
successful run emits a datapoint every minute, so a wedged probe alerts exactly like a slow one —
one metric, one alarm, no extra counters.

The handler lives in [`lambda/realtime-probe/index.mjs`](lambda/realtime-probe/index.mjs). It runs
`nodejs22.x` with **zero npm dependencies**: `WebSocket` and `crypto` are Node built-ins, the AWS
SDK v3 clients are bundled with the Lambda runtime. The Lambda runs in the private app tier (NAT
for the public ALB and AWS service egress) and reads its connection material from Secrets Manager:
`realtime_jwt_secret_arn` (`WS_JWT_SECRET`) and `redis_auth_secret_arn` (the `pubsub_url` field).

The probe publishes to the `school:*` Redis channel the gateway's `PSUBSCRIBE` pattern already
covers, so the gateway instance holding the probe's socket receives the publish regardless of which
gateway the ALB routed the connection to.

## Deploy annotations (ST-255)

`aws_cloudwatch_log_group.deploys` (`/<name_prefix>/deploys`) plus the dashboard's "Recent deploys"
log widget (a Logs Insights table, not a metric graph — CloudWatch has no API to drop a discrete
timestamped marker on a live metric widget outside a fixed dashboard revision). `infra/deploy/
scripts/annotate-deploy.sh` is the only writer, called once per outcome from `.github/workflows/
staging-deploy.yml`'s `annotate` job: one structured line per migration/deploy/smoke result,
queryable by `environment`/`service`/`status`/`actor` straight from the widget or `aws logs
start-query`.

**Known gap**: this module cannot grant its own writer permission, because the writer is a GitHub
Actions role defined outside it. Whichever role `staging-deploy.yml` assumes (today
`AWS_APPLY_ROLE_ARN`, the same identity `deploy.yml` already reuses for ECS operations — see
`infra/deploy/README.md`'s "Known gaps") needs `logs:CreateLogStream`/`logs:PutLogEvents` scoped to
`aws_cloudwatch_log_group.deploys.arn`. Not attached here.

## Prometheus/Grafana metrics stack (ST-259)

`monitoring_enabled = true` (staging/prod) provisions, all Terraform-owned directly (like
`modules/erpnext`'s own ECS resources, not `infra/deploy/scripts/deploy.sh`'s JSON-template path —
this is static infra, not an app-deploy artifact with a CI-pushed `IMAGE_TAG`):

- **Prometheus** (`prometheus.tf`): one Fargate task running this repo's own image
  (`infra/docker/prometheus.Dockerfile`, layering `infra/docker/prometheus/prometheus.yml` onto the
  upstream `prom/prometheus` image), scraping `apps/api`/`apps/realtime`/`apps/workers`' `/metrics`
  endpoints (`@studafy/observability`, `packages/observability/src/metricsServer.ts`) plus both DB
  exporters below. Ephemeral Fargate storage, not EFS — see "What this module does not do".
- **postgres_exporter** (`prometheus.tf`): unconditional whenever `monitoring_enabled` — every
  environment has a Postgres instance. Unmodified upstream image
  (`prometheuscommunity/postgres-exporter`); its `DATA_SOURCE_NAME` comes from
  `var.monitoring_secret_arn`'s `POSTGRES_EXPORTER_DSN` key. See
  `docs/runbooks/postgres-conventions.md`'s "Monitoring role" section for how that role/DSN is
  created — a manual bootstrap step, same as the Postgres master credential itself.
- **mysqld_exporter** (`prometheus.tf`): additionally conditional on `mariadb_exporter_enabled`
  (the ERPNext plane). Same shape as postgres_exporter; DSN key `MYSQLD_EXPORTER_DSN`. See
  `modules/mariadb/README.md`'s "Known gaps" for the equivalent bootstrap step.
- **Grafana** (`grafana.tf`): one Fargate task running this repo's own image
  (`infra/docker/grafana.Dockerfile`), with dashboards and datasources provisioned entirely from
  files in this repo (`infra/docker/grafana/{dashboards,provisioning}/**` — the "dashboards in
  repo" acceptance criterion). Its own task role grants exactly
  `cloudwatch:GetMetricData`/`ListMetrics`/`DescribeAlarms` (read-only) for its CloudWatch
  datasource — nothing else.

**Scrape-target discovery** (`discovery.tf`) is DNS-based, not IAM-based: a Cloud Map private DNS
namespace fixed at `metrics.internal` in every environment (see that file's own comment for why a
fixed name is safe — dev/staging/prod are separate, unpeered VPCs) gets one `A` record per running
task (`MULTIVALUE` routing), and Prometheus's `dns_sd_configs` resolves the whole fleet on every
scrape with zero AWS IAM permissions. `api`/`realtime`/`workers` register into it via their own
`service.json.tpl`'s `serviceRegistries` (`infra/deploy/scripts/render.sh` resolves each service's
registry ARN from this module's `metrics_discovery_service_arns` output, the same way it already
resolves each service's own secret ARN); Prometheus/Grafana/both exporters register directly, since
those `aws_ecs_service` resources are Terraform-owned here.

**Access**: Grafana has no public endpoint and no ALB in front of it — `module.network`'s
`monitoring` security group admits only the bastion, the same access model already used for
Postgres/Redis/PgBouncer administration. See `docs/runbooks/metrics-dashboard-catalog.md` for the
exact SSH port-forward command and the dashboard catalog itself.

### Cardinality budget

Every label on every metric this stack collects comes from a fixed, small vocabulary — never a
user id, school id, job id, or raw request path:

- **RED metrics** (`packages/observability/src/redMetrics.ts`): `http.route` is the _matched route
  pattern_ Hono's router resolved (`/students/:id`, never `/students/8f14e45f-...`), enforced
  structurally by which function computes the label, not by convention — see that file's own
  `redMetrics.test.ts` for a test that would fail if this regressed. `http.request.method` and
  `http.response.status_code` are bounded by construction (HTTP has finitely many of each).
- **Queue metrics** (`packages/observability/src/queueMetrics.ts`): `messaging.destination.name`
  is one of `QUEUE_NAMES` (`@studafy/constants`) — apps/workers' own fixed queue registry, not a
  job id or job name. `state`/`outcome` are BullMQ's own small enum of terminal/count states.
- **DB exporters**: `postgres_exporter`/`mysqld_exporter`'s own default collectors label by
  `datname`/database name and internal Postgres/MySQL identifiers — never a row, a query, or a
  tenant.

Estimated series count stays in the low hundreds even at full scale: `routes × methods ×
status_classes` per HTTP service (tens of routes × ~4 methods × ~5 status classes), `queues ×
states` for depth plus `queues × outcomes` for throughput (a dozen queues × ~7), and a small fixed
set per DB exporter — none of it scales with tenant count, user count, or traffic volume the way a
per-user or per-school label would.

## Inputs

| Name                                | Type           | Default            | Description                                                                         |
| ----------------------------------- | -------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `name_prefix`                       | `string`       | —                  | Resource name prefix, from `module.naming.name_prefix`.                             |
| `aws_region`                        | `string`       | —                  | Dashboard widget region.                                                            |
| `postgres_instance_id`              | `string`       | —                  | Primary RDS instance identifier.                                                    |
| `postgres_read_replica_instance_id` | `string`       | —                  | Read-replica identifier (lag alarm + widget).                                       |
| `mariadb_instance_id`               | `string`       | `null`             | Optional MariaDB instance identifier.                                               |
| `redis_replication_group_id`        | `string`       | —                  | ElastiCache replication group id (CPU/connections/evictions widget).                |
| `ecs_cluster_name`                  | `string`       | —                  | ECS cluster containing api/realtime/workers.                                        |
| `probe_enabled`                     | `bool`         | `false`            | Provision the synthetic realtime probe. Dev omits it; staging/prod pass `true`.     |
| `realtime_ws_url`                   | `string`       | —                  | Public `wss://…/ws` handshake URL the probe connects to.                            |
| `realtime_jwt_secret_arn`           | `string`       | —                  | ARN of the secret holding `WS_JWT_SECRET` (for the probe's handshake token).        |
| `redis_auth_secret_arn`             | `string`       | —                  | ARN of the Redis connection secret; the probe reads `pubsub_url`.                   |
| `probe_subnet_ids`                  | `list(string)` | —                  | Private app-tier subnets for the probe Lambda.                                      |
| `probe_security_group_ids`          | `list(string)` | —                  | App security group: egress covers Redis/HTTPS/DNS; nothing connects in.             |
| `log_retention_days`                | `number`       | `30`               | Probe Lambda log retention.                                                         |
| `probe_metric_namespace`            | `string`       | `Studafy/Realtime` | CloudWatch namespace for `RealtimeProbeLatency` (`Studafy/<component>` convention). |
| `probe_slo_ms`                      | `number`       | `2000`             | Propagation SLO in ms; the probe alarm threshold.                                   |
| `monitoring_enabled`                | `bool`         | `false`            | Provision Prometheus/Grafana/the exporters. Dev omits it; staging/prod pass `true`. |
| `vpc_id`                            | `string`       | —                  | VPC the Cloud Map private DNS namespace is created in.                              |
| `cluster_arn`                       | `string`       | —                  | ECS cluster ARN the metrics stack's own services run in.                            |
| `execution_role_arn`                | `string`       | —                  | Shared ECS execution role (`module.compute`), reused rather than a new one.         |
| `private_app_subnet_ids`            | `list(string)` | —                  | Private app-tier subnets for the metrics stack's Fargate tasks.                     |
| `monitoring_security_group_id`      | `string`       | —                  | Security group for the metrics stack (`module.network`'s `monitoring` group).       |
| `metrics_port`                      | `number`       | `9464`             | Port apps/api, apps/realtime, apps/workers expose `/metrics` on.                    |
| `grafana_port`                      | `number`       | `3000`             | Port Grafana listens on.                                                            |
| `monitoring_secret_arn`             | `string`       | —                  | ARN of the `monitoring` app-secrets container (exporter DSNs, Grafana password).    |
| `mariadb_exporter_enabled`          | `bool`         | `false`            | Provision `mysqld_exporter`. Should match `local.erpnext_plane_enabled`.            |
| `prometheus_image`                  | `string`       | —                  | Full image reference for this repo's Prometheus image.                              |
| `grafana_image`                     | `string`       | —                  | Full image reference for this repo's Grafana image.                                 |
| `prometheus_retention`              | `string`       | `"15d"`            | Prometheus `--storage.tsdb.retention.time` value.                                   |
| `prometheus_storage_gb`             | `number`       | `30`               | Fargate ephemeral storage (GiB) for the Prometheus task.                            |
| `prometheus_cpu` / `_memory`        | `number`       | `512` / `1024`     | Fargate sizing for the Prometheus task.                                             |
| `grafana_cpu` / `_memory`           | `number`       | `256` / `512`      | Fargate sizing for the Grafana task.                                                |
| `exporter_cpu` / `_memory`          | `number`       | `256` / `512`      | Fargate sizing for each DB exporter task.                                           |

## Outputs

| Name                             | Description                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dashboard_name`                 | Operations dashboard name.                                                                          |
| `alarm_arns`                     | All action-free alarm ARNs, including the probe alarm when enabled.                                 |
| `realtime_probe_function_name`   | Probe Lambda name, or `null` when the probe is disabled.                                            |
| `deploys_log_group_name`         | CloudWatch Logs group the staging deploy pipeline annotates.                                        |
| `metrics_discovery_service_arns` | Map of `{api, realtime, workers}` -> Cloud Map registry ARN — see `infra/deploy/scripts/render.sh`. |
| `grafana_access_hint`            | Reminder of the SSH port-forward command to reach Grafana.                                          |

## What this module does not do

- **It does not wire the probe's network.** It takes subnets and security groups as inputs;
  `module.network` owns VPC/egress and `module.redis` owns the Redis endpoint (see root `main.tf`).
- **It does not grant Redis access from the probe.** The probe shares the app security group, whose
  existing Redis ingress rule already admits app-tier traffic — nothing new needed.
- **It does not pin the ElastiCache CA cert.** The probe's TLS connection to Redis sets
  `rejectUnauthorized: false` because ElastiCache certs are not signed by a CA in Node's default
  trust store. Pinning the AWS RDS CA bundle would be stricter and is a known gap
  (`infra/deploy/README.md`).
- **It does not run a synthetic check against the workers' outbox-relay path.** The probe measures
  the realtime gateway fan-out core (Redis PUBLISH → PSUBSCRIBE → room broadcast) directly; the
  outbox relay additionally involves Postgres and the workers queue, which is outside a per-minute
  probe's scope.
- **Prometheus has no persistent volume.** Its TSDB lives on Fargate's own ephemeral task storage
  (`prometheus_storage_gb`), so a task replacement (deploy, crash, AZ event) resets scraped history
  — up to `prometheus_retention`'s worth of data, not just since the last scrape. Grafana's
  dashboards themselves are unaffected (dashboards-as-code, re-provisioned from the image on every
  start), and CloudWatch's own long-term retention is untouched by this. Adding EFS would fix it,
  at the cost of mount targets, an access point, and its own security-group wiring — not done here
  because nothing in ST-259's acceptance criteria requires history to survive a deploy.
- **It does not create the Postgres/MariaDB monitoring roles or assemble their DSNs.** Same
  "no SQL-executing Terraform provider" gap the master credential itself has — see
  `docs/runbooks/postgres-conventions.md`'s "Monitoring role" section and
  `modules/mariadb/README.md`'s "Known gaps" for the exact one-time bootstrap SQL, and
  `infra/terraform/README.md` for why the resulting DSN is supplied via
  `TF_VAR_secrets_app_secret_values` rather than assembled by Terraform.
- **Grafana has no public endpoint, SSO, or per-user accounts.** It's reachable only from the
  bastion (`module.network`'s `monitoring` security group), behind one shared admin credential
  (`monitoring_secret_arn`'s `GRAFANA_ADMIN_PASSWORD`). Fine for the small number of people who
  need dashboards today; fronting it with an internal ALB and real SSO is future work if that
  changes, not something this ticket's acceptance criteria ask for.
- **It does not mirror `prometheuscommunity/postgres-exporter` or `prom/mysqld-exporter` into this
  repo's own ECR.** Both task definitions pull the upstream images directly from Docker Hub —
  unlike Prometheus/Grafana, this repo doesn't layer any config onto them (a DSN is a runtime
  secret, not a file), so there's nothing to build. `module.network`'s `monitoring_https` egress
  rule is what makes that pull possible.
