# Secret rotation schedule

The quarterly calendar, cadence, ownership, and the shared audit/evidence procedure for every
secret-class rotation in this repo. This file is the schedule; the four per-class runbooks in this
directory are the how — see [`README.md`](README.md) for the index. The inventory of every secret
(which module creates it, what keys it holds) lives in
[`secrets-conventions.md`](../secrets-conventions.md).

## Cadence

| Class                            | Automatic rotation                                                | Quarterly drill                                    | Runbook                                                          |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| DB credentials (Postgres master) | Every `postgres_rotation_days` (default 30) — AWS rotation Lambda | Verify one on-demand rotation + zero-downtime gate | [`rotation-db.md`](rotation-db.md)                               |
| JWT signing keys                 | Every `JWT_KEY_ROTATION_INTERVAL_MS` (default 7d)                 | Verify JWKS overlap + audit trail                  | [`rotation-jwt-jwks.md`](rotation-jwt-jwks.md)                   |
| Provider API keys                | None                                                              | **Quarterly, manual**                              | [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md) |
| Webhook secrets                  | None                                                              | **Quarterly, manual**                              | [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md)     |

The two "None" rows are the load-bearing quarterly work. Everything else exists to be _verified_,
not to be manually rotated.

## Calendar

Quarters and their run week (the first full working week of the quarter; working week =
Sunday–Thursday `Asia/Amman`, [`on-call-rotation.md`](../on-call-rotation.md)'s convention):

| Quarter | Run week (Asia/Amman)              | Reminder auto-open                              |
| ------- | ---------------------------------- | ----------------------------------------------- |
| Q1      | First full working week of January | `1 Jan 09:00` (`secrets-rotation-schedule.yml`) |
| Q2      | First full working week of April   | `1 Apr 09:00`                                   |
| Q3      | First full working week of July    | `1 Jul 09:00`                                   |
| Q4      | First full working week of October | `1 Oct 09:00`                                   |

The first drill under these procedures is **Q4 2026** (October run week); each quarter thereafter.
A drill may be skipped only with the owning role's sign-off, recorded as the quarter's audit entry.

**Calendar automation** is `.github/workflows/secrets-rotation-schedule.yml`: on a cron at
`06:00 UTC` (09:00 Asia/Amman — Jordan is UTC+3 year-round) on 1 Jan/Apr/Jul/Oct, and on manual
`workflow_dispatch`, it opens a `secrets-rotation`-labeled GitHub issue that is the quarter's
checklist and record. The repo has no calendar product integration — a Git issue is the calendar
entry that also holds the evidence, same "issue as the durable alert" pattern the deploy pipelines
already use (`staging-deploy.yml`).

## Ownership

Roles, not names (repo convention — `on-call-rotation.md`, `launch/README.md`):

- **Executor** (runs the drill): the security-operations role, or the on-call primary as deputy.
- **Reviewer** (signs off evidence): the security role's lead. A drill is complete only when the
  review entry is in the quarter's issue thread.
- **No-man-name rule**: the issues assign by role tag, not GitHub identity.

## Zero-downtime standard

The acceptance criterion for every class is "rotated in staging following the runbook with zero
downtime". What that means per class, honestly:

- **DB**: client credentials (pgbouncer `api_username`/`api_password`) never change; the residual
  window is the pooler's ~1-minute refresh, shown not assumed during the drill
  ([`rotation-db.md`](rotation-db.md) "Honest zero-downtime assessment").
- **JWT**: JWKS overlap keeps the outgoing key verifiable through rotation; bounded by process
  lifetime and access-token TTL ([`rotation-jwt-jwks.md`](rotation-jwt-jwks.md)'s gaps).
- **Provider keys**: rolling ECS update at `minimumHealthyPercent 100`; the old value stays valid
  until the final "revoke old" step.
- **Webhooks**: sender-side overlap first, receiver roll second; the reverse order is an incident.

Staging is the drill environment; a class is not "rotated" in prod until verified in staging the
same quarter.

## Audit / evidence (the shared procedure)

Rotation events are audited at two layers; the drill records both into the quarter's issue.

### Layer 1 — CloudTrail (AWS-side rotations)

`secretsmanager` management events are recorded for every rotation the Lambda or Terraform
performs. Per class:

```bash
# DB master rotation (RotateSecret + the Lambda's PutSecretValue/UpdateSecretVersionStage),
# e.g. rotated at <time>, secret "<prefix>-postgres-connection":
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=secretsmanager.amazonaws.com \
  --start-time <YYYY-MM-DD>T00:00:00Z --end-time <YYYY-MM-DD>T23:59:59Z \
  --query "Events[?contains(CloudTrailEvent, 'postgres-connection')]" | jq -r \
  '.[] | .CloudTrailEvent | fromjson | .eventName'
```

```bash
# App-secret rotation via rotate-app-secret.sh (PutSecretValue + UpdateSecretVersionStage on
# "<prefix>/<service>/app-secrets") and the ECS roll (ecs.amazonaws.com UpdateService):
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=ecs.amazonaws.com \
  --start-time <date>T00:00:00Z --end-time <date>T23:59:59Z \
  --query "Events[?contains(CloudTrailEvent, 'UpdateService')]" \
  --output text | head -20
```

If a trail exists, prefer CloudWatch Logs Insights over the same event set for timestamped counts;
the CLI commands above are the minimum that works without knowing a trail's setup.

### Layer 2 — application structured logs

- **JWT rotation**: the api service logs `jwt key rotated` with the new `kid` on every in-process
  rotation (`apps/api/src/index.ts:139`).

  ```bash
  aws logs filter-log-events \
    --log-group-name /<name_prefix>/ecs/api \
    --filter-pattern '"jwt key rotated"'
  ```

- **Webhook signature rejections** during an overlap are `*_signature_invalid` rows in
  `app.security_events` (the sink in `apps/api/src/lib/security/securityEventSink.ts`) — _zero
  during a clean rotation_, and that zero is part of the evidence.

### Recording the quarter

Each drill ends with one comment on the quarter's issue containing: date/run window, class(es)
rotated, the CloudTrail event names observed, the zero-downtime gate result per class
(`healthz`/JWKS/pool checks), and reviewer sign-off. The issue is then closed.

## Status table and known gaps

| Secret                                                | Auto-rotation | Staged drill possible today          | Notes                                                    |
| ----------------------------------------------------- | ------------- | ------------------------------------ | -------------------------------------------------------- |
| Postgres master                                       | Yes (30d)     | Yes (single-user; window documented) | Dual-user swap documented, not enabled                   |
| JWT signing keys (api)                                | Yes (7d)      | Yes (verify-only)                    | In-memory keys; restart gap open                         |
| Provider API keys (Anthropic/Stripe/OAuth/ERPNext/S3) | No            | Wiring + script ready                | One-time per-key `task-definition` wiring required first |
| Webhook secrets (Stripe, ERPNext)                     | No            | Script ready                         | Sender-side overlap required                             |
| PgBouncer stats user / per-service creds              | No            | No                                   | No SAR app; bespoke Lambda follow-up                     |
| Redis AUTH token                                      | No            | No                                   | Same gap                                                 |
| MariaDB / ERPNext connection                          | No            | No                                   | Same gap                                                 |

The last three rows are pre-existing "[`secrets-conventions.md`](../secrets-conventions.md) Known
gaps", listed here so the quarterly review has the full inventory rather than a scoped one.
