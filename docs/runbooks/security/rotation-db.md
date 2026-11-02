# Secret rotation: database credentials

The `<name_prefix>-postgres-connection` Secrets Manager secret — the RDS Postgres 16 master
credential (`engine, host, port, dbname, username, password, sslmode`). This is one of the four
secret classes in the quarterly rotation schedule
([`rotation-schedule.md`](rotation-schedule.md)); the inventory lives in
[`secrets-conventions.md`](../secrets-conventions.md).

Per-service application secrets (provider keys, webhook secrets, `WS_JWT_SECRET`) are a different
class — [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md).

## What already rotates itself

The master credential rotation is automatic and was wired before this runbook existed
(`infra/terraform/modules/secrets/rotation.tf`): AWS's published
`SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda (deployed via the Serverless Application
Repository) rotates the secret every `postgres_rotation_days` days (default 30) and once
immediately when `aws_secretsmanager_secret_rotation` is first created. The Lambda runs the
four-step `createSecret` / `setSecret` / `testSecret` / `finishSecret` state machine against the
live RDS instance.

PgBouncer is in the loop whether or not the app tier is: every `modules/pgbouncer` pool authenticates
to Postgres as the master user (no per-service login role exists yet —
[`postgres-conventions.md`](../postgres-conventions.md)'s "Known gaps"). PgBouncer's
`user_data` installs `pgbouncer-refresh-credentials.sh` on a systemd timer (`OnUnitActiveSec=60`,
`RandomizedDelaySec=10`): it re-reads the secret from Secrets Manager, rewrites `userlist.txt`, and
`systemctl reload`s PgBouncer. So after a rotation the new password reaches the pooler within at
most ~70 seconds without replacing the EC2 instance or changing a client credential
(`infra/terraform/modules/pgbouncer/templates/user_data.sh.tftpl`).

## Honest zero-downtime assessment

- **Client-facing credentials never change.** `api`/`workers` connect to PgBouncer with
  `api_username`/`api_password` from the pgbouncer secret, which rotation does not touch. The app
  tier is unaffected by a master rotation.
- **The residual window is the pooler's.** Between the Lambda's `setSecret` (RDS now accepts only
  the new password) and PgBouncer's next refresh, a _new_ backend connection negotiated with the
  old password fails. Bounded by the timer (≈10–70s) plus the rotation Lambda's own run time.
  Established connections survive (`ALTER USER ... PASSWORD` does not kill sessions); PgBouncer
  transaction pooling reuses idle server connections.
- **True "dual-user swap" — zero-window rotation — is not enabled yet.** It needs per-service
  Postgres login roles and either AWS's Multi-User rotation Lambda or a bespoke swap, none of which
  exist (see "Dual-user swap design" below). The quarterly drill below runs the single-user
  rotation and records the actual health delta; that is the honest acceptance criterion this
  environment can meet today.

## Quarterly drill (staging)

The schedule is quarterly per [`rotation-schedule.md`](rotation-schedule.md); the DB class also
rotates itself every 30 days whether or not the drill runs. This drill is the _verification_ pass,
not the rotation: it triggers one rotation on demand, watches it finish, and proves the new
credential works.

Requires: `aws` CLI, `jq`, and an identity with `secretsmanager:RotateSecret`,
`secretsmanager:DescribeSecret`, `secretsmanager:GetSecretValue` on the secret ARN.

```bash
# 1. Resolve the secret ARN and rotate on demand.
SECRET_ARN="$(terraform -chdir=infra/terraform output -raw postgres_connection_secret_arn)"
aws secretsmanager rotate-secret --secret-id "$SECRET_ARN"

# 2. Poll until rotation finishes — RotationEnabled true, and no in-progress AWSPENDING version.
aws secretsmanager describe-secret \
  --secret-id "$SECRET_ARN" \
  --query '{RotationEnabled: RotationEnabled, LastRotatedDate: LastRotatedDate, VersionIdsToStages: VersionIdsToStages}'

# 3. Confirm the new password works. From the bastion or any instance the db security group admits:
pg_secret=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" \
  --query SecretString --output text)
PGPASSWORD=$(echo "$pg_secret" | jq -r .password) \
  psql "host=$(echo "$pg_secret" | jq -r .host) port=$(echo "$pg_secret" | jq -r .port) \
        dbname=$(echo "$pg_secret" | jq -r .dbname) user=$(echo "$pg_secret" | jq -r .username) \
        sslmode=require" -c 'select now();'
```

Zero-downtime gate for the drill: pass, not assume.

- If the app tier is deployed, `curl -sf https://<edge_domain>/healthz` succeeds through the whole
  run, and `psql` on the pgbouncer pool with `api_username`/`api_password` succeeds within the
  refresh window.
- Expected, honest outcome: a few seconds where a brand-new backend connection using the old master
  password is refused by RDS; no client-visible failure because clients authenticate to the pooler,
  not RDS, and the pooler's server connections stay alive.

## Failure triage

A rotation that does not finish: check the Lambda's own CloudWatch Logs group
`/aws/lambda/<name_prefix>-postgres-rotation` first — the four-step state machine logs which step
failed and why. `KeyError: 'engine'` on `setSecret` means the secret JSON lost its `engine` key
(never delete it — it exists solely for the Lambda; [`secrets-conventions.md`](../secrets-conventions.md))
`SecretStagesAssertionError` on `finishSecret` usually means the Lambda's VPC/subnet/security-group
wiring cannot reach the database or its Secrets Manager endpoint (rules from
`modules/network`'s `secrets_rotation_security_group_id`).

Never "fix" a failed rotation by disabling `aws_secretsmanager_secret_rotation` and re-seeding the
secret string — that reverts the Lambda-managed value to a Terraform-configured one and recreates
the exact drift `modules/postgres/main.tf`'s `lifecycle { ignore_changes = [secret_string] }` exists
to prevent.

## Dual-user swap design (follow-up, not yet enabled)

What "zero connection-refused window" requires, and why it is not on today:

1. **Per-service Postgres login roles.** `db/migrations/000002` creates `studafy_admin` (NOLOGIN
   owner) and `studafy_app` (NOLOGIN, least privilege); no _login_ role exists for the app to
   authenticate as. Create e.g. `studafy_api` LOGIN IN ROLE studafy_app, so least privilege and
   rotation both stop depending on the master credential.
2. **Two interchangeable credential sets.** Pair A/B (e.g. two login roles, or one role swapped
   between two secret versions). Rotation: refresh the _inactive_ set, point PgBouncer pools at it,
   verify, retire the old set — never a moment with neither valid.
3. **Enrollment in AWS rotation.** Either the SAR `SecretsManagerRDSPostgreSQLRotationMultiUser`
   app (rotates a user secret against a stable master) or a bespoke Lambda calling
   `rotate-secret` with the alternating pairs. The SAR app's parameter contract has the same
   "not yet applied to a real account" caveat as the single-user one —
   [`secrets-conventions.md`](../secrets-conventions.md)'s "Known gaps".

When the roles land, this runbook's drill changes from "run single-user and watch the window" to
"run the swap and assert no window". Until then the honest statement is the one in the assessment
above.

## Known gaps

- The sub-minute pgbouncer refresh window above is real and is the current ceiling.
- Redis AUTH, PgBouncer's stats user, and the MariaDB/ERPNext secret are separate secret classes
  with no rotation configured (see the schedule's status table and [`secrets-conventions.md`](../secrets-conventions.md)).
