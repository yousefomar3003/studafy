# `monitoring`

CloudWatch alarms, the operations dashboard, and the synthetic realtime probe (ST-149).

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

## Outputs

| Name                           | Description                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| `dashboard_name`               | Operations dashboard name.                                          |
| `alarm_arns`                   | All action-free alarm ARNs, including the probe alarm when enabled. |
| `realtime_probe_function_name` | Probe Lambda name, or `null` when the probe is disabled.            |

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
