# `monitoring`

CloudWatch alarms, the operations dashboard, the synthetic realtime probe (ST-149), the
Prometheus/Grafana metrics stack (ST-259), the tracing pipeline (ST-260), alerting and on-call
(ST-262), and the black-box synthetic availability probes (ST-263).

## Alarms & dashboard

Every alarm is defined once, in `alerts.tf`'s `local.cloudwatch_alarms`, with a severity, an
Alertmanager alert name and the description that becomes the notification's summary. That one map
drives three consumers — the alarms themselves, the bridge Lambda's routing catalog, and
`scripts/check-alert-rules.ts` in CI — which is what makes "every alert has a severity and a
runbook" a property of the type rather than a review comment: an entry missing either is a
plan-time error.

Alarms notify through `module.alert_topic` into Alertmanager wherever `monitoring_enabled` is true.
They stay **action-free in dev**, where there is no monitoring plane to deliver to and no rotation
to deliver to it — they still evaluate, and still show their state on the dashboard.

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

## Black-box synthetic availability probes (ST-263)

`synthetics_enabled = true` (staging/prod) provisions one Lambda
([`lambda/synthetics-probe/index.mjs`](lambda/synthetics-probe/index.mjs)), deployed identically in
**two regions** — `var.aws_region` (the default provider) and `synthetics_dr_region` (`aws.dr`,
the same alias root `providers.tf` already maintains for `module.backup`'s cross-region backup
replication, reused here rather than adding a third region-only alias) — scheduled every minute in
each. Every check is an unauthenticated, side-effect-free GET against a real public entry point:

| Check               | Request                                                      | Success                                                                                                                    |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `login-page`        | `GET {web_origin}/auth/login`                                | `200`                                                                                                                      |
| `healthz`           | `GET {api_origin}/healthz`                                   | `200 {"status":"ok"}`                                                                                                      |
| `oauth-start`       | `GET {api_origin}/api/auth/oauth/google/start`               | any status `< 500` (302 configured, 404 not — see the Lambda's own header)                                                 |
| `checkout-page`     | `GET {web_origin}/pricing`                                   | `200` — apps/web has no route literally named "checkout"; `/pricing` is the public page the real checkout flow starts from |
| `invitation-verify` | `GET {api_origin}/api/auth/invitations/{fixed token}/verify` | `400 INVITATION_INVALID` — a fixed, never-issued token, per `docs/security/invitation_verification_matrix.md`              |

Unlike the realtime probe above, **every check publishes a metric point every run regardless of
outcome** (`SyntheticCheckSuccess`, 1/0, dimensioned by `Check`) — five independent checks per
invocation need "healthz is up but checkout-page is down" to be answerable, which a
publish-on-success-only metric cannot do. `SyntheticCheckLatency` (ms) rides alongside it.
`alerts.tf`'s `synthetic_alarms`/`synthetic_alarms_dr` alarm on the rolling average falling below 1
for 2 consecutive minutes, `treat_missing_data = "breaching"` covering the Lambda not having run at
all — see [`docs/runbooks/alert-catalog.md#syntheticcheckfailing`](../../../../docs/runbooks/alert-catalog.md#syntheticcheckfailing).

**Why two regions and no VPC**: see `synthetics.tf`'s own header comment — in short, the
application runs in exactly one region, so the second probing region exists to catch a regional
DNS/network/CDN-POP failure that a probe running next to the application would never see; and every
target is a public HTTPS endpoint, so (unlike the realtime probe) there is no VPC, NAT, or Redis
connection to wire.

**The `<prefix>-availability-slo` dashboard** (`synthetics.tf`) is NFR-03's SLO dashboard: one
widget per check, both regions' rolling hourly success rate plotted against
`synthetics_availability_slo_percent`'s `ANNOTATION_LINE`, plus one combined latency widget. Kept
separate from the operations dashboard on purpose — that one answers "is the infrastructure
healthy"; this one answers "is the user-facing availability SLO being met", a different question
for a different audience.

**Honesty note**: no NFR-03 document exists anywhere in this repo (checked `docs/`) — the same gap
[`docs/testing/load-test-scenarios.md`](../../../../docs/testing/load-test-scenarios.md) records for
NFR-01/02. `synthetics_availability_slo_percent` (99.9, overridable) is a conventional default, not
a transcription of a real target.

## Public status page sync (ST-264)

`status_page_enabled = true` (staging/prod, and only meaningful alongside `monitoring_enabled` and
`synthetics_enabled`) provisions one more scheduled Lambda
([`lambda/status-page-sync/index.mjs`](lambda/status-page-sync/index.mjs), `status_page.tf`), same
rate(1 minute) shape as the two probes above. Every run it `DescribeAlarms`s the synthetic-check and
realtime-probe alarms mapped to each public component and PATCHes that component's status on the
status-page provider:

| Public component | Automatic signal                                                               |
| ---------------- | ------------------------------------------------------------------------------ |
| `web`            | `login-page` synthetic check, both probing regions                             |
| `api`            | `healthz` + `oauth-start` + `invitation-verify` synthetic checks, both regions |
| `billing`        | `checkout-page` synthetic check, both regions                                  |
| `realtime`       | the ST-149 probe's own `realtime-probe-latency-high` SLO alarm                 |
| `ai`             | **none — see "Honesty note" below**                                            |

Any mapped alarm in `ALARM` flips that component to `major_outage`; all clear flips it back to
`operational`. `INSUFFICIENT_DATA` (and a `DescribeAlarms` call that simply didn't return a state)
is not treated as a failure, for the same "absence of an opinion" reason
[`alert-catalog.md`](../../../../docs/runbooks/alert-catalog.md) already gives for CloudWatch
alarms generally — see the Lambda's own header.

**Why polling, not the SNS alert bridge next door.** `alerts.tf`'s `alert_topic` already fans every
alarm state change out over SNS to `lambda/cloudwatch-alert-bridge`. Reacting the same way here
would need hand-rolled state aggregation (a component maps to more than one alarm); polling
`DescribeAlarms` every minute instead recomputes every component's status from scratch each run, so
a missed or out-of-order notification self-corrects on the very next run rather than leaving the
public page wrong until someone notices. See `status_page.tf`'s header for the rest of this
reasoning, including why the page itself is a third-party provider account rather than something
this repo hosts and emails subscribers from.

**Required secrets**, added to the existing `monitoring` app-secrets container
(`monitoring_secret_arn` — see "Alerting and on-call" below for how that container already carries
Alertmanager's receiver URLs the identical way):

| Key                                 | Holds                                 |
| ----------------------------------- | ------------------------------------- |
| `STATUS_PAGE_API_KEY`               | Provider API credential.              |
| `STATUS_PAGE_PAGE_ID`               | The provider's page id.               |
| `STATUS_PAGE_COMPONENT_ID_API`      | Provider component id for `api`.      |
| `STATUS_PAGE_COMPONENT_ID_WEB`      | Provider component id for `web`.      |
| `STATUS_PAGE_COMPONENT_ID_BILLING`  | Provider component id for `billing`.  |
| `STATUS_PAGE_COMPONENT_ID_REALTIME` | Provider component id for `realtime`. |

The page itself, its five components (`ai` included) and the credential that mints
`STATUS_PAGE_API_KEY` are created once, by hand, in the provider's own dashboard — this module has
no Terraform provider for it and does not attempt to create them, the identical boundary
`on-call-rotation.md` already draws for the paging provider's schedule.

**Honesty note.** `ai` has no automatic signal because this repo has no synthetic probe against the
Anthropic provider today — `docs/runbooks/ai-provider-outage.md`'s own Detection section says so
directly ("There is no CloudWatch alarm targeting Anthropic's availability today"). Rather than
invent one to make five components look wired the same way, `ai` is simply absent from this
Lambda's component map; its status is set by hand on the provider, same as an AI outage is triaged
today. See [`docs/runbooks/incident-comms-templates.md`](../../../../docs/runbooks/incident-comms-templates.md)
for manual incident updates (all five components) and the templates to use when posting one.

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

## Alerting and on-call (ST-262)

`monitoring_enabled = true` additionally provisions **Alertmanager** (`alertmanager.tf`) — one
Fargate task running this repo's own image (`infra/docker/alertmanager.Dockerfile`), registered at
`alertmanager.metrics.internal` like every other member of the plane.

It is the single place every alert is routed, deduplicated, grouped and silenced, **including the
ones that do not come from Prometheus**. That is the point of the bridge:

```
  Prometheus rules ─────────────┐
  (infra/docker/prometheus/     │
   rules/*.yml, baked into      ▼
   the Prometheus image)   Alertmanager ──► severity route ──► on-call provider
                                ▲
  CloudWatch alarms ─► SNS ─► alert-bridge Lambda
  (this module's alerts.tf)    (lambda/cloudwatch-alert-bridge)
```

The split at the _source_ is forced and cannot be removed: Fargate has no host to run
`node_exporter` on, and RDS replica lag, ElastiCache CPU, ACM certificate expiry and the ST-149
probe have no scrapeable endpoint at all. The split stops at the source. Both planes use the same
three severities (`critical` / `warning` / `info`), the same receivers, the same silences and the
same fortnightly noisy-alert review — one place to look during an incident, one place to silence
something at 3am.

**Receiver URLs are secrets and never reach a rendered config.** `alertmanager.yml` references them
as `url_file` paths; `docker-entrypoint.sh` materialises each into a 0600 file from the task's
injected `ALERTMANAGER_PAGE_URL` / `ALERTMANAGER_TICKET_URL` / `ALERTMANAGER_HEARTBEAT_URL`, which
come from the `monitoring` app-secrets container. Alertmanager re-reads the file per notification,
so a rotated URL needs no image rebuild.

**Certificate expiry is the one thing here that needs two regions.** CloudFront only accepts ACM
certificates issued in us-east-1, and a CloudWatch alarm can only publish to an SNS topic in its own
region — so the CDN certificate's alarms and their topic live there. `modules/alert-topic/` is that
topic, its customer-managed KMS key and its subscription, packaged as a sub-module because Terraform
cannot select a provider per `for_each` key. The _Lambda_ is not duplicated: SNS delivers
cross-region, so both topics subscribe the same function.

See [`docs/runbooks/alert-catalog.md`](../../../../docs/runbooks/alert-catalog.md) for the alert
catalog, the severity matrix, the test-fire drill and the noisy-alert review, and
[`on-call-rotation.md`](../../../../docs/runbooks/on-call-rotation.md) for the rotation itself.

## Distributed tracing pipeline (ST-260)

`monitoring_enabled = true` (the same flag as the metrics stack — this ticket depends on ST-259,
so there is no separate toggle) additionally provisions, in `tracing.tf`:

- **OTel collector** (`otel-collector.tf` section of `tracing.tf`): one Fargate task running this
  repo's own image (`infra/docker/otel-collector.Dockerfile`, layering
  `infra/docker/otel-collector/config.yaml` onto the upstream `otel/opentelemetry-collector-contrib`
  image), receiving OTLP/HTTP spans from apps/api, apps/realtime and apps/workers
  (`@studafy/observability`'s `tracing.ts`, `httpTracing.ts`, `queueTracing.ts`) on
  `otel_collector_port` (4318). Every span reaches the collector — the SDK samples nothing
  (`AlwaysOnSampler`) — and the collector's `tail_sampling` processor makes the actual sampling
  decision ST-260's acceptance criterion asks for: sample the whole trace if any span in it has
  `status_code = ERROR`, **or** with 10% probability otherwise (two top-level policies combine as
  OR, not AND). See that config file's own comments for why this can't be done as head sampling.
- **Tempo** (same file): one Fargate task running this repo's own image
  (`infra/docker/tempo.Dockerfile`, layering `infra/docker/tempo/tempo.yaml` onto the upstream
  `grafana/tempo` image, single-binary mode), storing whatever the collector forwards. Ephemeral
  Fargate storage, not EFS — same "What this module does not do" trade-off as Prometheus, and Tempo's
  own `block_retention` is deliberately short (24h) because that storage is not durable across a
  task replacement anyway.
- **Grafana's Tempo datasource** (`grafana.tf`'s existing task, no new resource): provisioned from
  `infra/docker/grafana/provisioning/datasources/datasources.yml.tpl`, with `tracesToLogsV2`
  pointed at the CloudWatch datasource — a span in the Tempo UI links straight to a CloudWatch Logs
  Insights query filtered to that trace's id. The other direction ("trace links from logs") is
  `requestId.ts`/`activeTraceFields()`: every apps/api request log line, and the handful of
  workers-side log lines closest to an active job span, already carry `trace_id`/`span_id`.

**One trace across API -> outbox -> dispatcher -> FCM** (the acceptance criterion's own example,
a grade-publish request) holds together end to end without any layer in between taking a tracing
dependency:

1. `createTracingMiddleware()` (apps/api's `app.ts`) starts a SERVER span for the request and makes
   it active via `context.with()` — every `await` inside the request, including nested service
   calls, sees it as the ambient active span through Node/Bun's `AsyncLocalStorage`.
2. `emit()` (apps/api's `lib/events/emitter.ts`) wraps the `app.outbox_events` insert in a CLIENT
   span (`outbox.emit`) for every domain event this codebase writes, not just grades — this is what
   gives the trace its "outbox" segment (see `enqueue-dispatch.ts`'s own header for why the
   grades-published path enqueues its BullMQ job directly rather than the dispatcher consuming this
   row).
3. `enqueueNotificationDispatch()` (apps/api) calls `injectTraceContext()` and carries the result on
   the job payload's `traceContext` field, across the Redis boundary.
4. `worker.ts`'s `createBullmqWorker` (apps/workers) wraps every processor in the registry — every
   queue, not just this one — in `withConsumerSpan()`, extracting `job.data.traceContext` and
   continuing the same trace. `dispatcher.worker.ts`'s `processNotificationDispatch` runs inside
   that span with no tracing import of its own.
5. `enqueueDelivery()` (apps/workers' `registry.ts`) captures the dispatcher's own active span with
   `injectTraceContext()` when it fans out to the delivery job, so step 4 repeats one hop later for
   `processNotificationDelivery`.
6. `delivery.worker.ts` wraps the actual FCM call in a CLIENT span (`fcm.send`) — the trace's last
   hop, and where a dead credential or a quota error shows up as a trace-level error rather than
   only a log line.

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

| Name                                  | Type           | Default              | Description                                                                                    |
| ------------------------------------- | -------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `name_prefix`                         | `string`       | —                    | Resource name prefix, from `module.naming.name_prefix`.                                        |
| `aws_region`                          | `string`       | —                    | Dashboard widget region.                                                                       |
| `postgres_instance_id`                | `string`       | —                    | Primary RDS instance identifier.                                                               |
| `postgres_read_replica_instance_id`   | `string`       | —                    | Read-replica identifier (lag alarm + widget).                                                  |
| `mariadb_instance_id`                 | `string`       | `null`               | Optional MariaDB instance identifier.                                                          |
| `redis_replication_group_id`          | `string`       | —                    | ElastiCache replication group id (CPU/connections/evictions widget).                           |
| `ecs_cluster_name`                    | `string`       | —                    | ECS cluster containing api/realtime/workers.                                                   |
| `probe_enabled`                       | `bool`         | `false`              | Provision the synthetic realtime probe. Dev omits it; staging/prod pass `true`.                |
| `realtime_ws_url`                     | `string`       | —                    | Public `wss://…/ws` handshake URL the probe connects to.                                       |
| `realtime_jwt_secret_arn`             | `string`       | —                    | ARN of the secret holding `WS_JWT_SECRET` (for the probe's handshake token).                   |
| `redis_auth_secret_arn`               | `string`       | —                    | ARN of the Redis connection secret; the probe reads `pubsub_url`.                              |
| `probe_subnet_ids`                    | `list(string)` | —                    | Private app-tier subnets for the probe Lambda.                                                 |
| `probe_security_group_ids`            | `list(string)` | —                    | App security group: egress covers Redis/HTTPS/DNS; nothing connects in.                        |
| `log_retention_days`                  | `number`       | `30`                 | Probe Lambda log retention.                                                                    |
| `probe_metric_namespace`              | `string`       | `Studafy/Realtime`   | CloudWatch namespace for `RealtimeProbeLatency` (`Studafy/<component>` convention).            |
| `probe_slo_ms`                        | `number`       | `2000`               | Propagation SLO in ms; the probe alarm threshold.                                              |
| `monitoring_enabled`                  | `bool`         | `false`              | Provision Prometheus/Grafana/the exporters. Dev omits it; staging/prod pass `true`.            |
| `vpc_id`                              | `string`       | —                    | VPC the Cloud Map private DNS namespace is created in.                                         |
| `cluster_arn`                         | `string`       | —                    | ECS cluster ARN the metrics stack's own services run in.                                       |
| `execution_role_arn`                  | `string`       | —                    | Shared ECS execution role (`module.compute`), reused rather than a new one.                    |
| `private_app_subnet_ids`              | `list(string)` | —                    | Private app-tier subnets for the metrics stack's Fargate tasks.                                |
| `monitoring_security_group_id`        | `string`       | —                    | Security group for the metrics stack (`module.network`'s `monitoring` group).                  |
| `metrics_port`                        | `number`       | `9464`               | Port apps/api, apps/realtime, apps/workers expose `/metrics` on.                               |
| `grafana_port`                        | `number`       | `3000`               | Port Grafana listens on.                                                                       |
| `monitoring_secret_arn`               | `string`       | —                    | ARN of the `monitoring` app-secrets container (exporter DSNs, Grafana password).               |
| `mariadb_exporter_enabled`            | `bool`         | `false`              | Provision `mysqld_exporter`. Should match `local.erpnext_plane_enabled`.                       |
| `prometheus_image`                    | `string`       | —                    | Full image reference for this repo's Prometheus image.                                         |
| `grafana_image`                       | `string`       | —                    | Full image reference for this repo's Grafana image.                                            |
| `prometheus_retention`                | `string`       | `"15d"`              | Prometheus `--storage.tsdb.retention.time` value.                                              |
| `prometheus_storage_gb`               | `number`       | `30`                 | Fargate ephemeral storage (GiB) for the Prometheus task.                                       |
| `prometheus_cpu` / `_memory`          | `number`       | `512` / `1024`       | Fargate sizing for the Prometheus task.                                                        |
| `grafana_cpu` / `_memory`             | `number`       | `256` / `512`        | Fargate sizing for the Grafana task.                                                           |
| `exporter_cpu` / `_memory`            | `number`       | `256` / `512`        | Fargate sizing for each DB exporter task.                                                      |
| `otel_collector_port`                 | `number`       | `4318`               | OTLP/HTTP port, shared by the collector's receiver and Tempo's own OTLP receiver.              |
| `otel_collector_image`                | `string`       | —                    | Full image reference for this repo's OTel collector image.                                     |
| `tempo_image`                         | `string`       | —                    | Full image reference for this repo's Tempo image.                                              |
| `otel_collector_cpu` / `_memory`      | `number`       | `256` / `512`        | Fargate sizing for the OTel collector task.                                                    |
| `tempo_cpu` / `_memory`               | `number`       | `512` / `1024`       | Fargate sizing for the Tempo task.                                                             |
| `tempo_storage_gb`                    | `number`       | `21`                 | Fargate ephemeral storage (GiB) for the Tempo task.                                            |
| `alertmanager_image`                  | `string`       | —                    | Full image reference for this repo's Alertmanager image.                                       |
| `alertmanager_port`                   | `number`       | `9093`               | Port Alertmanager serves its API/UI on.                                                        |
| `alertmanager_cpu` / `_memory`        | `number`       | `256` / `512`        | Fargate sizing for the Alertmanager task.                                                      |
| `edge_certificate_arn`                | `string`       | —                    | `module.edge`'s ACM certificate, watched for expiry.                                           |
| `cdn_certificate_arn`                 | `string`       | `null`               | `module.cdn`'s us-east-1 ACM certificate; `null` where there is no CDN.                        |
| `synthetics_enabled`                  | `bool`         | `false`              | Provision the black-box synthetic probes. Dev omits it; staging/prod pass `true`.              |
| `web_origin`                          | `string`       | —                    | apps/web origin; builds the `login-page`/`checkout-page` probe URLs.                           |
| `api_origin`                          | `string`       | —                    | apps/api origin; builds the `healthz`/`oauth-start`/`invitation-verify` probe URLs.            |
| `synthetics_dr_region`                | `string`       | —                    | Second probing region (root passes `var.backup_dr_region`).                                    |
| `synthetics_metric_namespace`         | `string`       | `Studafy/Synthetics` | CloudWatch namespace for the probe's metrics.                                                  |
| `synthetics_availability_slo_percent` | `number`       | `99.9`               | Proposed per-check NFR-03 availability SLO, as a percent (see honesty note above).             |
| `status_page_enabled`                 | `bool`         | `false`              | Provision the status-page sync Lambda. Should track `monitoring_enabled`/`synthetics_enabled`. |

## Outputs

| Name                              | Description                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dashboard_name`                  | Operations dashboard name.                                                                          |
| `alarm_arns`                      | Every CloudWatch alarm ARN this module creates, both regions.                                       |
| `realtime_probe_function_name`    | Probe Lambda name, or `null` when the probe is disabled.                                            |
| `deploys_log_group_name`          | CloudWatch Logs group the staging deploy pipeline annotates.                                        |
| `metrics_discovery_service_arns`  | Map of `{api, realtime, workers}` -> Cloud Map registry ARN — see `infra/deploy/scripts/render.sh`. |
| `grafana_access_hint`             | Reminder of the SSH port-forward command to reach Grafana.                                          |
| `alert_topic_arn`                 | SNS topic in-region alarms publish to, bridged into Alertmanager. `null` in dev.                    |
| `alert_bridge_function_name`      | The bridge Lambda; its log group is where an undelivered alarm notification is diagnosed.           |
| `synthetics_probe_function_name`  | Synthetic probe Lambda name (same in both regions), or `null` when disabled.                        |
| `availability_slo_dashboard_name` | NFR-03 availability SLO dashboard name, or `null` when synthetics are disabled.                     |
| `status_page_sync_function_name`  | Status-page sync Lambda name, or `null` when disabled.                                              |

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
- **Tempo has no persistent volume either**, for the identical reason Prometheus doesn't — see the
  bullet above. `tempo_storage_gb` bounds it, and `tempo.yaml`'s `block_retention: 24h` is
  deliberately short because that storage was never going to survive a task replacement anyway.
- **Dev has no collector to push to, and does not try.** `infra/deploy/environments/dev.env` leaves
  `OTEL_COLLECTOR_ENDPOINT` empty, which each service's `env.ts` and `index.ts` turn into
  `startTracing()` never running at all — not a client that dials a DNS name with zero records
  behind it. See `apps/api/src/env.ts`'s own comment on `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **The collector's `tail_sampling` decision is per-collector-instance, not fleet-wide.** With a
  single collector task (`desired_count = 1`, unconditionally) this doesn't matter; it would if this
  ever scaled to multiple collector replicas without a consistent-routing load balancer in front,
  since a trace's spans could then land on different instances and never be evaluated together.
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
- **It does not define the on-call rotation.** Alertmanager maps severity to one of three webhook
  URLs; who is on call, what hours a `warning` may wake someone, and how long an unacknowledged page
  waits before escalating all live in the on-call provider behind those URLs. That boundary is
  partly forced — Alertmanager's time intervals _mute_ a matched route rather than diverting it, so
  "page in hours, ticket otherwise" cannot be written as two sibling routes — and partly deliberate:
  the provider already owns the schedule, and a second copy here would drift from it. The
  specification the provider is configured to is
  `docs/runbooks/on-call-rotation.md`.
- **Alertmanager runs at `desired_count = 1`.** Its HA story is a gossip cluster needing a stable
  peer list, which Fargate does not provide; two _unclustered_ replicas would notify twice for every
  alert, which is worse than one. The `Watchdog` alert's five-minute heartbeat is the mitigation
  this trade rests on — see `alertmanager.tf`'s own comment, and do not remove one without
  revisiting the other.
- **It does not alert on the standing size of either dead-letter store.**
  `app.notification_dead_letters` is RLS-forced per school, so a global count would be one query per
  tenant on every scrape. The alerts count _arrivals_ instead
  (`dead_letter_entries_total`), which answers "something was parked and nobody has looked at it";
  the undrained backlog is a drain-time question the runbook answers with SQL. The practical
  consequence is in the runbook: those alerts resolving means "no new dead letters", never "the
  store is empty".
- **It does not mirror `prometheuscommunity/postgres-exporter` or `prom/mysqld-exporter` into this
  repo's own ECR.** Both task definitions pull the upstream images directly from Docker Hub —
  unlike Prometheus/Grafana, this repo doesn't layer any config onto them (a DSN is a runtime
  secret, not a file), so there's nothing to build. `module.network`'s `monitoring_https` egress
  rule is what makes that pull possible.
- **`checkout-page` probes `/pricing`, not a page named "checkout".** No route in `apps/web` is
  literally named that — every real checkout endpoint is an authenticated, side-effecting Stripe
  session creation, unsuitable for a once-a-minute unauthenticated probe. `/pricing` is the public
  page the checkout flow actually starts from; see `lambda/synthetics-probe/index.mjs`'s header.
- **`oauth-start` cannot tell "not configured" apart from "working".** A 302 to Google and the
  route's own coded 404 ("Google OAuth is not configured") both count as success — only a 5xx or a
  timeout fails the check. Whether Google/Microsoft OAuth credentials are actually configured for a
  given environment is a secrets-provisioning concern outside a black-box probe's reach.
- **The availability dashboard has no 30-day error-budget burn-rate math.** Each widget shows a
  rolling 1-hour success rate against the proposed SLO line — a fast, legible signal for "is this
  check healthy right now", not a multi-window burn-rate alert like `ApiAvailabilityFastBurn`/
  `ApiAvailabilitySlowBurn` (Prometheus, `slo.yml`). Building the CloudWatch equivalent (metric math
  over a rolling 30-day window, evaluated at multiple burn rates) is future work if NFR-03 turns out
  to need it once a real target exists.
- **It does not create the status-page provider account, its page, or its five components.** Same
  "provider owns its own side" boundary `on-call-rotation.md` already draws for the paging provider
  — there is no Terraform provider for a status-page product, so the page/components/API credential
  are created once by hand and their ids handed to `status_page.tf` as secrets, not resources.
- **It does not give `ai` an automatic status.** No synthetic probe against the Anthropic provider
  exists in this repo — see the "Public status page sync" section's honesty note and
  `docs/runbooks/ai-provider-outage.md`. `ai`'s status on the provider is set by hand until that
  probe exists.
- **It does not send subscriber emails, and does not build an incident-authoring UI.** Both are the
  status-page provider's job — the same reason this module integrates with one rather than hosting
  its own page. `docs/runbooks/incident-comms-templates.md` documents the manual workflow and the
  copy to use.
