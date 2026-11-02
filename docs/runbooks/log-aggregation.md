# Log aggregation: query, retention, and audit (ST-261)

Operational runbook for the log-aggregation pipeline (`infra/terraform/modules/logging`). The
pipeline ships every service's stdout (CloudWatch -> Firehose -> S3 -> Vector -> Loki), labels each
line `service`/`tenant`/`env`/`level`, keeps ~30d of hot history in Loki and ~13 months of cold
history in S3, and mirrors security streams write-once. The module's own README
(`infra/terraform/modules/logging/README.md`) covers the design and all inputs/outputs; the line
schema is defined in [`docs/architecture/SAD_28_logging_conventions.md`](../architecture/SAD_28_logging_conventions.md).

## Access

Loki has no public endpoint — `module.network`'s `logging` security group admits only the bastion,
Grafana, and Vector (same access model as Grafana/Postgres administration). Reach it with an SSH
local port-forward through the bastion, resolving Loki's Cloud Map DNS name
(`loki.logging.internal`) from inside the VPC:

```bash
ssh -L 3100:loki.logging.internal:3100 ec2-user@<bastion-public-ip>
# then, on the workstation:
curl -s "http://localhost:3100/loki/api/v1/labels"
```

The bastion's public IP and every pipeline resource name come from
`terraform output` / `aws` (see the module's [Outputs](../terraform/modules/logging/README.md#outputs)).

## Acceptance criterion 1: request_id search across services

A request's `request_id` is generated per request (`apps/api/src/request-context.ts`) and sits at
the root of every NDJSON line (`SAD_28_logging_conventions.md`), so one id correlates the api
request line, realtime/worker processing, and any error logged afterwards across services. Two ways
to ask:

**Grafana Explore** (Loki datasource, any environment with the pipeline):

```logql
{env=~".+"} | json | request_id="<id>"
```

**The script** (bastion or workstation with the port-forward up —
`infra/terraform/modules/logging/scripts/trace-request.sh`):

```bash
infra/terraform/modules/logging/scripts/trace-request.sh --since 24h <request_id>
```

It filters with `|= "<id>"` first (cheap, server-side) then `| json | request_id=` (exact match),
and prints the matched lines time-ordered with their `service` label. Exit 1 with a hint if nothing
matches — including the ~1-2 min stdout-to-Loki floor (`firehose_buffer_seconds`, see the module
README), so retry for very recent requests.

## Acceptance criterion 2: retention policies verified

**Hot tier (Loki, 30d).** `LOKI_RETENTION` is the compactor's `retention_period`, and deleting
chunks older than it is the compactor's job — S3 does not. Confirm the deployed value (default
`720h`):

```bash
aws ecs describe-task-definition \
  --task-definition "<name_prefix>-loki" \
  --query 'taskDefinition.containerDefinitions[0].environment' --output table
```

**Cold tier (archive bucket, ~13 months).** The lifecycle rule transitions at
`archive_transition_days` (30 -> Glacier IR) and expires at `archive_expiration_days` (395). Verify
from the bucket itself:

```bash
aws s3api get-bucket-lifecycle-configuration --bucket "<archive_bucket_id>"
```

A non-empty archive object listing (`aws s3 ls "s3://<archive_bucket_id>/logs/"`) confirms delivery;
the `date=yyyy/MM/dd/` prefix is the day-partition a cold restore (Athena, or targeted re-ingest)
scopes by.

**Security mirror (write-once).** Object Lock, COMPLIANCE mode, `security_lock_retention_days`:

```bash
aws s3api get-object-lock-configuration --bucket "<security_bucket_id>"
```

`Mode: COMPLIANCE` with `Days: 395` means nothing — not the root account, not a `terraform destroy`
— can delete or overwrite an object before that elapses. The lifecycle rule there expires on the
same horizon but only takes effect once the lock has elapsed, so the two numbers stay consistent by
construction.

> Everything in `terraform output` (archive/security buckets, streams, queues, subscribed groups) is
> echoed from the deployed infrastructure — `terraform output` is the single source for verifying
> against these criteria, not memory.

## Acceptance criterion 3: PII audit script sample clean

`scripts/pii-audit.sh` pulls a sample of recently aggregated lines (`--since 1h`, `--limit 5000`)
and crosses them against detectors for email, JWT/Bearer tokens, AWS keys, private keys, inline
passwords, Luhn-valid PANs, and E.164 phone numbers. Known-safe structured ids (`request_id`,
`school_id`, `user_id`) are scrubbed first so their UUIDs can never trip a detector. Exit 0 and
"sample clean" is the pass; exit 1 lists the offending line's labels and a redacted match.

```bash
infra/terraform/modules/logging/scripts/pii-audit.sh --loki-url http://localhost:3100 --since 1h
```

Produce a _clean_ sample the same way any sampling gate works — feed it real, current traffic:

```bash
# drive a normal request so api logs a request_completed line:
curl -s "https://<api-origin>/v1/..." -o /dev/null
# wait > firehose_buffer_seconds, then:
infra/terraform/modules/logging/scripts/pii-audit.sh --since 5m
```

SAD §28 is the invariant behind "clean": every dynamic value passes through `JSON.stringify`, so raw
PII _should_ never reach a line. A finding means the emitting call site broke that rule (most
commonly by interpolating an unstringified value); the script's report points at the suspect.

## Pipeline health / troubleshooting

| Signal                            | Command                                                                                                       | Non-zero meaning                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Firehose delivery                 | `aws firehose describe-delivery-stream --delivery-stream-name "<main_stream>"`                                | `DeliveryStreamStatus` not `ACTIVE`, or `LastDeliveryAttemptTime` stale     |
| Vector backlog                    | `aws sqs get-queue-attributes --queue-url "<ingest_queue_url>" --attribute-names ApproximateNumberOfMessages` | Depth climbing = S3 objects queued but Vector not draining                  |
| Vector failure                    | `aws sqs get-queue-attributes --queue-url "<ingest_dlq_url>" --attribute-names ApproximateNumberOfMessages`   | Non-zero = a poison archive object; inspect within the 14-day DLQ retention |
| Vector / Loki / Firehose own logs | `aws logs tail "/<name_prefix>/ecs/vector" --follow` (and `/ecs/loki`, `/firehose/logs`)                      | Pipeline's own operational noise, separate from the app logs it carries     |
| Loki reachable from Vector        | `curl -s http://loki.logging.internal:<loki_port>/ready` from a Vector task (or Grafana's datasource health)  | A broken link between collector and store                                   |

**known honest gaps:** no retention or budget alarms exist for Loki beyond the pipeline's own
CloudWatch groups (a filling hot store or a wedged compactor won't page anyone), and Loki's
`/config` (for a definitive `retention_period`) is not exposed beyond the task-definition check
above. Both are future work, not acceptance-criterion blockers.
