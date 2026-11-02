# Metrics dashboard catalog (ST-259)

Dashboard catalog for the Prometheus/Grafana metrics stack (`infra/terraform/modules/monitoring`).
Every dashboard listed here is a file in this repo — `infra/docker/grafana/dashboards/*.json` — and
is provisioned into Grafana read-only at container start (`allowUiUpdates: false` in
`infra/docker/grafana/provisioning/dashboards/dashboards.yml`): to change a panel, edit the JSON
file and redeploy Grafana (bump `grafana_image_tag`, `terraform apply`), not the UI.

> **If the "Studafy" folder is empty in a Grafana older than ST-262**, that is the
> `COPY --chmod=644` bug fixed in `infra/docker/grafana.Dockerfile`: the flag applied 644 to the
> dashboards _directory_ as well as its files, leaving it without an execute bit and every
> dashboard unreadable. Provisioning logs the read failure and starts anyway, so there was no other
> symptom. Redeploy with a `grafana_image_tag` built after that fix.

## Access

Grafana has no public endpoint — `module.network`'s `monitoring` security group admits only the
bastion (same access model as Postgres/Redis/PgBouncer administration,
`docs/runbooks/pgbouncer-conventions.md`). Reach it with an SSH local port-forward through the
bastion, resolving Grafana's Cloud Map DNS name (`grafana.metrics.internal`) from inside the VPC:

```bash
ssh -L 3000:grafana.metrics.internal:3000 ec2-user@<bastion-public-ip>
# then open http://localhost:3000 — admin / <GRAFANA_ADMIN_PASSWORD>
```

The bastion's public IP is `module.network`'s `bastion_public_ip` output; the admin password is
whatever was supplied as `monitoring.GRAFANA_ADMIN_PASSWORD` in
`TF_VAR_secrets_app_secret_values` (see `infra/terraform/README.md`).

## Distributed tracing (ST-260)

Traces are not a dashboard panel — they're explored per-trace, not aggregated — so there is no
`tracing.json` file here. Once you're through the same SSH port-forward above (Grafana, not Tempo
directly: Tempo has no UI of its own), open **Explore**, pick the **Tempo** datasource, and either
search by service/span name or paste a `trace_id` straight from a log line — every `apps/api`
request log and the workers-side log lines closest to an active job span carry one (`requestId.ts`/
`activeTraceFields()`, `@studafy/observability`). From a trace view, "Logs" on any span jumps to a
CloudWatch Logs Insights query pre-filtered to that trace, via the Tempo datasource's
`tracesToLogsV2` config (`infra/docker/grafana/provisioning/datasources/datasources.yml.tpl`).

Remember only sampled traces are here at all: the OTel collector
(`infra/docker/otel-collector/config.yaml`) keeps a trace only if some span in it errored, or with
10% probability otherwise — "the request I'm looking for isn't in Tempo" is the expected outcome
90% of the time for a request that didn't error, not a broken pipeline.

## Dashboards

All four live in the "Studafy" folder, refresh every 30s, and default to the last 6 hours.

| Dashboard                   | File            | Data sources           | Covers                                                                                                                     |
| --------------------------- | --------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **API — RED**               | `api.json`      | Prometheus, CloudWatch | Request rate/error rate/p95/p99 latency by route for `apps/api`; ECS CPU/memory.                                           |
| **Realtime — RED**          | `realtime.json` | Prometheus, CloudWatch | `/ws` handshake rate/failure rate/p95 duration; other route traffic; the ST-149 synthetic probe's latency; ECS CPU/memory. |
| **Workers — queue metrics** | `workers.json`  | Prometheus, CloudWatch | Job throughput/failure rate/p95 duration and queue depth per `QUEUE_NAMES` entry; ECS CPU/memory.                          |
| **Database**                | `db.json`       | Prometheus, CloudWatch | `postgres_exporter`/`mysqld_exporter` up/down, connections, commit/rollback rate; RDS replica lag/CPU/storage.             |

### API — RED (`api.json`, uid `studafy-api`)

| Panel                     | Query (PromQL / CloudWatch)                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Request rate by route     | `sum by (http_route) (rate(http_server_request_duration_count{job="api"}[5m]))`                                 |
| Error rate (5xx) by route | same, filtered to `http_response_status_code=~"5.."`                                                            |
| p95 latency by route      | `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_bucket{job="api"}[5m])))`  |
| p99 latency (overall)     | same, without the `http_route` group-by                                                                         |
| Error ratio (overall)     | 5xx rate ÷ total rate                                                                                           |
| ECS CPU / memory          | `AWS/ECS` `CPUUtilization`/`MemoryUtilization`, `ServiceName` resolved via the `$ecs_service` template variable |

### Realtime — RED (`realtime.json`, uid `studafy-realtime`)

Same RED shape as API, scoped to `job="realtime"`, plus:

- **`/ws` handshake rate by outcome** — `http_response_status_code` `101` (upgraded) vs. `401`
  (missing/invalid token, `apps/realtime/src/app.ts`'s `/ws` route).
- **Realtime probe latency** — the same ST-149 synthetic-probe `RealtimeProbeLatency` metric the
  CloudWatch operations dashboard already alarms on (`modules/monitoring/main.tf`), mirrored here
  so realtime's whole health picture is in one place.

### Workers — queue metrics (`workers.json`, uid `studafy-workers`)

| Panel                                | Query                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Job throughput by queue and outcome  | `sum by (messaging_destination_name, outcome) (rate(bullmq_job_outcomes_total{job="workers"}[5m]))`                       |
| Failure rate by queue                | same, filtered to `outcome="failed"`                                                                                      |
| p95 processing duration by queue     | `histogram_quantile(0.95, sum by (le, messaging_destination_name) (rate(bullmq_job_duration_bucket{job="workers"}[5m])))` |
| Queue depth by state                 | `bullmq_queue_jobs{job="workers"}` (waiting/active/delayed/failed/completed, observed live on every scrape)               |
| Backlog (waiting + delayed) by queue | `sum by (messaging_destination_name) (bullmq_queue_jobs{job="workers",state=~"waiting                                     | delayed"})` |

### Database (`db.json`, uid `studafy-db`)

`pg_up`/`mysql_up` stat panels, Postgres active backends and commit/rollback rate
(`pg_stat_database_*`), MySQL/MariaDB connections (`mysql_global_status_threads_connected`,
ERPNext plane only), plus RDS replica lag/CPU/storage via CloudWatch (`$postgres_instance`/
`$mariadb_instance` template variables). **Verify exact `postgres_exporter`/`mysqld_exporter`
metric names against the pinned image versions before relying on this in a real incident** —
same "not exercised against a live account" caveat every third-party-image integration in this
repo carries (see `infra/terraform/modules/erpnext/README.md` for the precedent).

## Why two data sources per dashboard

Prometheus and CloudWatch cover genuinely different layers, not overlapping ones:

- **Prometheus** carries everything `@studafy/observability` and the DB exporters emit: RED
  metrics per route, BullMQ queue depth/throughput, and Postgres/MySQL internals — signals with
  labels and histogram buckets CloudWatch has no equivalent for.
- **CloudWatch** carries node/infra-level signals Fargate's own boundary makes impossible to get
  any other way: there is no host to run `node_exporter` against on Fargate, so ECS Container
  Insights (CPU/memory/network per task) and RDS's own engine-level metrics (replica lag, storage)
  are the only source for that layer. Grafana's native CloudWatch datasource reads them directly —
  no exporter needed, no metrics duplicated into Prometheus.

## Cardinality budget

See `infra/terraform/modules/monitoring/README.md`'s own "Cardinality budget" section for the full
accounting. In one line: every label is drawn from a fixed, small vocabulary — a matched route
pattern, an HTTP method, a status class, a queue name from `QUEUE_NAMES`, a BullMQ state/outcome,
or a database name — never a user id, school id, job id, or raw request path. Series count is
`O(routes × methods × status_classes)` plus `O(queues × states)`, not `O(users)` or `O(schools)`.

## Known gaps

- Dashboard JSON is hand-written, not generated from a typed library (e.g. grafonnet/grafana-
  foundation-sdk) — acceptable at four dashboards and a dozen panels; revisit if the catalog grows
  much larger and hand-edited JSON starts drifting or duplicating boilerplate.
- Grafana-managed alert rules are still not used, and deliberately: alerting is owned by Prometheus
  rules plus Alertmanager (ST-262 — `infra/docker/prometheus/rules/*.yml`,
  `docs/runbooks/alert-catalog.md`), so Grafana here is for looking at things, not for paging. Two
  alerting surfaces over the same metrics would be two places to silence an alert at 3am. The
  CloudWatch alarms are no longer action-free either — they reach the same Alertmanager through the
  bridge in `modules/monitoring/alerts.tf`.
- No long-term (>`prometheus_retention`) metrics history — see
  `infra/terraform/modules/monitoring/README.md`'s "What this module does not do" for the ephemeral-
  storage tradeoff.
