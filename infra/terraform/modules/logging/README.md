# `logging`

The log-aggregation pipeline (ST-261): CloudWatch Logs -> Firehose -> S3 -> Vector -> Loki, plus a
write-once security mirror. It aggregates every service's stdout (`api`/`realtime`/`workers`/
`migrations`), labels each line `service`/`tenant`/`env`/`level` in Loki, keeps a searchable copy
for `loki_retention` (30d) and an immutable cold archive for ~13 months. See
[`docs/runbooks/log-aggregation.md`](../../../../docs/runbooks/log-aggregation.md) for how to search
it, verify retention, and run the PII audit.

```
            CloudWatch Logs groups (api, realtime, workers, migrations)
                 |                          |
   subscription filter (main)   subscription filter (security, whole security groups only)
                 |                          |
        Firehose `logs` ──────────────> Firehose `logs-security`
                 |                          |
        S3 `logs-archive`              S3 `logs-security` (Object Lock COMPLIANCE)
        (cold tier, 13mo)              (write-once mirror, no collector in the path)
                 |
        S3 -> SQS notification
                 |
        Vector (aws_s3 source, SQS-driven)
          |                         |
          |  Loki (hot tier, 30d)   |  per-line `kind="security"` events -> write-once bucket
          v                         v
      loki.logging.internal      logs-security
     (Grafana / logcli / PII audit)
```

## Why the two stores

"30d hot / 13mo cold" (SAD §28) is implemented as two deliberately decoupled stores, because they
live and die on different policies:

- **Hot** is Loki's own object store (`<prefix>-loki-chunks` in S3). Its lifetime is governed by
  Loki's compactor (`loki_retention`, default `720h`); the S3 bucket itself carries only a debris
  sweep (noncurrent versions, aborted multipart uploads).
- **Cold** is `<prefix>-logs-archive`, written by Firehose before Vector ever reads it. A lifecycle
  rule transitions it to `GLACIER_IR` at `archive_transition_days` (30) and expires it at
  `archive_expiration_days` (395). Loki deleting a chunk at 30d has no effect on the archive copy,
  and vice versa — that separation is the point.

## The security stream

Two mechanisms, one guarantee ("security stream mirrored write-once"):

1. **Whole security log groups** (`security_log_group_names`, today the bastion's SSH audit log) are
   subscribed to a _second_ Firehose (`logs-security`) that writes straight to `<prefix>-logs-
security` — an S3 Object Lock bucket in `COMPLIANCE` mode with a default retention of
   `security_lock_retention_days`. No collector sits in that path, so the immutability guarantee
   does not depend on Vector staying healthy. Those groups are also in the main pipeline, so the
   same lines are still searchable in Loki.
2. **Per-line security events** (`kind == "security"` in an app NDJSON line) are routed by Vector to
   the same Object Lock bucket, keyed with a UUID so a re-put lands as a new immutable object.

Neither the Firehose delivery role nor Vector holds `s3:PutObjectRetention` or `s3:DeleteObject`,
so nothing in the pipeline can shorten the retention it just set.

## Latency floor

`firehose_buffer_seconds` (default 60) is the floor of stdout-to-queryable latency: subscription
delivery is near-instant, but Firehose buffers before flushing, and only after the S3 object
notification can Vector move the line to Loki. The security stream flushes harder (60s / 1 MiB) so
audit lines are committed quickly.

## Inputs

| Name                           | Type           | Default        | Description                                                                                           |
| ------------------------------ | -------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `name_prefix`                  | `string`       | —              | Canonical resource prefix, from `module.naming.name_prefix`.                                          |
| `aws_region`                   | `string`       | —              | Region for the S3 records, SQS queue, and both Fargate services' AWS clients.                         |
| `environment`                  | `string`       | —              | Fallback for the `env` label on lines that arrive without their own `env` field.                      |
| `vpc_id`                       | `string`       | —              | VPC for the `logging.internal` Cloud Map namespace.                                                   |
| `cluster_arn`                  | `string`       | —              | ECS cluster the Vector/Loki Fargate services run in.                                                  |
| `execution_role_arn`           | `string`       | —              | Shared ECS execution role (module.compute) — image pulls + awslogs driver only.                       |
| `private_app_subnet_ids`       | `list(string)` | —              | Private app-tier subnets for the Vector/Loki tasks.                                                   |
| `logging_security_group_id`    | `string`       | —              | Security group for the logging plane (module.network's `logging` group).                              |
| `loki_port`                    | `number`       | `3100`         | HTTP API port, shared with module.network so SG rules and sink URLs cannot drift.                     |
| `app_log_group_names`          | `list(string)` | —              | CloudWatch groups shipped through the main pipeline (api/realtime/workers/migrations).                |
| `security_log_group_names`     | `list(string)` | `[]`           | Groups every line of which is a security event; mirrored write-once in addition to the main pipeline. |
| `vector_image`                 | `string`       | —              | Full ECR reference for this repo's Vector image.                                                      |
| `loki_image`                   | `string`       | —              | Full ECR reference for this repo's Loki image.                                                        |
| `loki_retention`               | `string`       | `"720h"`       | Loki compactor retention (`N h` syntax) — the hot, queryable window.                                  |
| `archive_transition_days`      | `number`       | `30`           | S3 Standard -> Glacier IR age for archive objects.                                                    |
| `archive_expiration_days`      | `number`       | `395`          | Archive deletion age (~13 months).                                                                    |
| `security_lock_retention_days` | `number`       | `395`          | Object Lock COMPLIANCE default retention for the security bucket.                                     |
| `firehose_buffer_seconds`      | `number`       | `60`           | Main-stream buffering hint; the latency floor.                                                        |
| `firehose_buffer_mib`          | `number`       | `5`            | Main-stream buffering size hint.                                                                      |
| `sqs_max_receive_count`        | `number`       | `5`            | Ingest-queue failures before an object is moved to the DLQ.                                           |
| `vector_desired_count`         | `number`       | `2`            | Vector replicas (safe: the queue shares work, Loki dedupes redelivery).                               |
| `vector_cpu` / `vector_memory` | `number`       | `512` / `1024` | Fargate sizing for each Vector task.                                                                  |
| `loki_cpu` / `loki_memory`     | `number`       | `512` / `1024` | Fargate sizing for the Loki task.                                                                     |
| `loki_storage_gb`              | `number`       | `30`           | Ephemeral storage for Loki's working scratch (chunks/index are in S3).                                |
| `plane_log_retention_days`     | `number`       | `30`           | CloudWatch retention for the pipeline's _own_ logs (Vector, Loki, Firehose errors).                   |

## Outputs

| Name                                                                       | Description                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `loki_internal_url`                                                        | In-VPC Loki base URL (`http://loki.logging.internal:<port>`).                       |
| `loki_discovery_service_arn`                                               | Cloud Map service ARN for Loki (`aws_service_discovery_service.loki`).              |
| `archive_bucket_id` / `_arn`                                               | Cold-archive bucket (id for lifecycle verification, arn for scoping readers).       |
| `security_bucket_id` / `_arn`                                              | Write-once security bucket (id for Object Lock verification).                       |
| `chunks_bucket_id`                                                         | Loki's chunk/index store (the hot tier's backing store).                            |
| `ingest_queue_url` / `ingest_dlq_url`                                      | SQS queue Vector drains (and its DLQ — a non-zero DLQ depth means a poison object). |
| `firehose_delivery_stream_name` / `firehose_security_delivery_stream_name` | Both delivery streams.                                                              |
| `vector_service_name` / `loki_service_name`                                | ECS service names.                                                                  |
| `subscribed_log_group_names` / `security_subscribed_log_group_names`       | The cross-service forwarding list.                                                  |
| `pii_audit_hint`                                                           | The PII-audit invocation against an SSH port-forwarded Loki.                        |

## How a change ships

Static infrastructure, Terraform-owned directly (like `modules/monitoring`'s stack — this is not on
`infra/deploy/scripts/deploy.sh`'s CI-pushed image-tag path). Two ways to change it:

- **Config baked into the images** (`vector.yaml`, `loki-config.yml.tpl`): bump `vector_image_tag` /
  `loki_image_tag` in the environment's Terraform vars and re-apply — the same rolling-deploy shape
  as `prometheus_image_tag`/`grafana_image_tag` (ST-259).
- **Infrastructure shape** (buffers, retention, sizing, subscriptions): change a variable or the
  module and re-apply.

## What this module does not do

- **It does not create the harness around itself.** Subnets, the security group, the VPC and the
  `logging.internal` namespace's VPC association, and the app log groups come in as inputs from
  `module.network` / `module.compute`.
- **Firehose cannot make `s3:*` destination notifications safer than AWS allows.** Excluding
  `errors/` from the SQS notification is the only filter — Firehose has no "only these groups" flag
  for notifications, so the input contract is enforced at subscription time (main pipeline gets
  exactly `app_log_group_names` + `security_log_group_names`).
- **It does not give the security bucket to `terraform destroy` before its retention elapses.** An
  Object-Lock COMPLIANCE object cannot be deleted by anyone — including the deploying account — for
  `security_lock_retention_days`. This is the guarantee working as intended, and the README's honest
  corollary: a mistaken write is also permanent for that long.
- **Loki's hot store is S3-backed, not EFS.** Chunks and the TSDB index live in the chunks bucket,
  so a task replacement loses nothing durable; only working scratch is on the task's ephemeral disk.
- **No log dashboards are provisioned.** Grafana gets a Loki datasource (works regardless of the
  module being deployed — see `infra/docker/grafana/provisioning/datasources/datasources.yml.tpl`)
  but no log dashboards; the acceptance criteria ask for scripted search/audit, not UI panels.
- **Not exercised against a live account.** Same caveat every Terraform module in this repo carries
  (see `modules/erpnext/README.md` for the precedent): no `terraform apply` or `docker build` has
  run against the exact third-party image tags pinned here. The Loki/Vector version pins
  (`loki.Dockerfile`, `vector.Dockerfile`) and the exact sink config should be treated as needing a
  smoke test on first real deploy.
