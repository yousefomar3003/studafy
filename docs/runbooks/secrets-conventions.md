# Secrets inventory and rotation runbook

Source of the resources this doc describes:
[`infra/terraform/modules/secrets`](../../infra/terraform/modules/secrets) for the per-service
containers and Postgres rotation; [`infra/terraform/modules/postgres`](../../infra/terraform/modules/postgres),
[`infra/terraform/modules/redis`](../../infra/terraform/modules/redis) and
[`infra/terraform/modules/pgbouncer`](../../infra/terraform/modules/pgbouncer) for the data-tier
secrets `modules/secrets` composes read access to but does not own.

## Secrets inventory

Every Secrets Manager secret this infrastructure creates, in one place — the individual modules'
own READMEs document each one where it's created; this table is the cross-module index.

| Secret path                           | Created by          | Contents (JSON keys)                                                                          | Rotated?                                                     |
| ------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `<name_prefix>-postgres-connection`   | `modules/postgres`  | `engine, host, port, dbname, username, password, sslmode`                                     | Yes — `modules/secrets`, every `postgres_rotation_days` days |
| `<name_prefix>-redis-auth`            | `modules/redis`     | `auth_token, primary_endpoint, reader_endpoint, port, tls, cache_db, queue_db`                | No — see "Known gaps" below                                  |
| `<name_prefix>-pgbouncer-connection`  | `modules/pgbouncer` | `port, ca_cert_pem, server_cert_pem, server_key_pem, stats_username, stats_password, sslmode` | No — see "Known gaps" below                                  |
| `<name_prefix>/<service>/app-secrets` | `modules/secrets`   | Operator-defined, per service (e.g. `WS_JWT_SECRET` for `realtime`)                           | No — Terraform is the source of truth (see below)            |

`<name_prefix>` is `module.naming.name_prefix`, e.g. `studafy-prod`. The three
`<name_prefix>/<service>/app-secrets` containers default to `api`, `realtime` and `workers` —
`modules/pgbouncer`'s `service_pools` default and `modules/registry`'s `image_repository_names`
default, kept in sync by hand across all three (no cross-module reference ties them together, same
tradeoff `modules/pgbouncer/README.md` already documents for its own default).

**No secret's value is ever a Terraform output.** Every module that creates one only ever outputs
its ARN; grant `secretsmanager:GetSecretValue` to the IAM identity that needs the value instead of
reading it out through `terraform output`. `secrets_app_secret_values` (root) /
`app_secret_values` (`modules/secrets`) is marked `sensitive = true`, so Terraform redacts it from
plan/apply output — the same protection every module's generated password already gets by simply
never being an output.

## Application secrets: what exists today, and how to set one

`apps/realtime/src/env.ts` is the one genuine application secret in this repo today —
`WS_JWT_SECRET`, which defaults to `"dev-insecure-secret-change-me"` and is explicitly flagged
there as something "production deployments must override." `apps/api` and `apps/workers` have no
secret-shaped environment variable at all yet (`apps/api/src/env.ts`, `apps/workers/src/env.ts`).

To set a real value for an environment:

```bash
export TF_VAR_secrets_app_secret_values='{"realtime":{"WS_JWT_SECRET":"<generated value>"}}'
terraform apply -var-file=environments/<env>/<env>.tfvars
```

Never put this in a `*.tfvars` file — `secrets_app_secret_values` is `sensitive`, but a `*.tfvars`
file committing the actual value would defeat that regardless (`.gitignore` already blocks
`*.tfvars` by default and re-includes only the three non-secret environment overlays; see
`infra/terraform/README.md`).

## Injecting secrets into a running service (not yet wired end-to-end)

No compute tier exists yet (`infra/terraform/README.md`'s status note), so nothing in this repo
today actually sets an environment variable from one of these secrets at deploy time. What this
module prepares, ahead of that:

- A canonical path per service (`<name_prefix>/<service>/app-secrets`) and ARN
  (`secrets_service_secret_arns` root output) a compute module can reference without inventing its
  own naming.
- A read-only managed IAM policy per service (`secrets_service_iam_policy_arns` root output),
  scoped to exactly that service's own container plus the shared data-tier secrets it's declared
  to need (`modules/secrets/main.tf`'s `services` map) — attach it to the service's task role via
  `aws_iam_role_policy_attachment` once one exists.

The intended mechanism, once an ECS (or similar) compute module exists, is ECS's own
`secrets` block on the container definition — this is the AWS-native "inject as an env var at
container start" primitive, distinct from `modules/pgbouncer`'s EC2 "fetch via the AWS CLI at
boot" pattern (that instance has no ECS task definition to declare secrets on):

```json
{
  "containerDefinitions": [
    {
      "name": "realtime",
      "secrets": [
        { "name": "WS_JWT_SECRET", "valueFrom": "<realtime app-secrets ARN>:WS_JWT_SECRET::" },
        { "name": "REDIS_URL", "valueFrom": "<derived — see below>" }
      ]
    }
  ]
}
```

`valueFrom` can point at a whole secret (injects its raw `SecretString`) or, with the
`<arn>:<json-key>::` suffix shown above, at a single key inside a JSON secret — ECS resolves it at
task launch, before the container's entrypoint runs, the same "runtime env, not baked into the
image" property `docs/runbooks/postgres-conventions.md` and `docs/runbooks/redis-conventions.md`
already describe for `DATABASE_URL`/`REDIS_URL`. Those two are not stored as a single string
anywhere — the Postgres and Redis secrets store their component fields (`host`, `port`, `password`,
...) separately, so assembling the final connection-string env var is a task-definition-level
concern (e.g. a small init container, or multiple `secrets` entries the app's own `env.ts`
composes) that belongs to whatever ticket adds the compute module, not this one.

## Postgres credential rotation

### How it's wired

`modules/secrets` deploys AWS's published `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda
(via the Serverless Application Repository) into the private-app subnets, and attaches it to
`modules/postgres`'s connection secret with `aws_secretsmanager_secret_rotation` on a
`postgres_rotation_days`-day schedule (default 30). Single-user strategy: the Lambda logs in as
`studafy_admin` and changes its own password in place — see `modules/secrets/README.md` for why
alternating-users rotation (no connection-refused window during the swap) isn't used yet.

Enabling `aws_secretsmanager_secret_rotation` rotates the secret **once, immediately**
(`rotate_immediately = true` in `modules/secrets/rotation.tf`, made explicit rather than left to
the provider's own default of the same value). In dev, that first `terraform apply` adding the
resource is itself the acceptance criterion's "DB credential rotation runbook executed once in
dev" — there is no separate manual trigger needed the first time.

### Running the rotation drill again (dev)

To exercise rotation a second time (or verify the schedule is live) without waiting for
`postgres_rotation_days`:

```bash
aws secretsmanager rotate-secret \
  --secret-id "$(terraform output -raw postgres_connection_secret_arn)"

# Poll until rotation finishes — RotationEnabled true and no in-progress AWSPENDING version:
aws secretsmanager describe-secret \
  --secret-id "$(terraform output -raw postgres_connection_secret_arn)" \
  --query '{RotationEnabled: RotationEnabled, LastRotatedDate: LastRotatedDate, VersionIdsToStages: VersionIdsToStages}'

# Confirm the new password actually works, from the bastion:
pg_secret=$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw postgres_connection_secret_arn)" \
  --query SecretString --output text)
PGPASSWORD=$(echo "$pg_secret" | jq -r .password) \
  psql "host=$(echo "$pg_secret" | jq -r .host) port=$(echo "$pg_secret" | jq -r .port) \
        dbname=$(echo "$pg_secret" | jq -r .dbname) user=$(echo "$pg_secret" | jq -r .username) \
        sslmode=require" -c 'select now();'
```

If rotation fails, check the Lambda's own CloudWatch Logs group
(`/aws/lambda/<name_prefix>-postgres-rotation`) first — the four-step `createSecret` /
`setSecret` / `testSecret` / `finishSecret` state machine logs which step failed and why.

### Why `modules/postgres` carries a `lifecycle.ignore_changes`

Once rotation is attached, the Lambda calls `PutSecretValue` directly against the live secret —
`modules/postgres/main.tf`'s own `aws_secretsmanager_secret_version.postgres` resource still holds
the _original_ seed password in its `secret_string` argument (`random_password.master.result`),
because nothing in Terraform's own state model observes an out-of-band API call the Lambda makes.
Without `lifecycle { ignore_changes = [secret_string] }` on that resource, the next
`terraform apply` would see its configured `secret_string` still equal to the seed password,
"correct" the drift, and silently overwrite the live rotated password back to a stale one —
locking out every connection using the current credential. This is a standard, expected
consequence of combining Terraform-managed secret creation with Lambda-managed rotation, not a
workaround for a bug.

**Consequence:** if `modules/postgres/main.tf`'s `jsonencode({...})` block ever needs a new key
(the way this ticket added `engine`), a plain `terraform apply` after editing it will **not**
update an already-existing secret — `ignore_changes` suppresses that diff too. Temporarily remove
the `lifecycle` block (or run a targeted `terraform apply -replace=module.postgres.aws_secretsmanager_secret_version.postgres`)
to push a structural change through, then restore it.

### Why the secret JSON has an `engine` key nothing else in this repo reads

AWS's rotation Lambda (`SecretsManagerRDSPostgreSQLRotationSingleUser`) requires
`"engine": "postgres"` in the secret's JSON and raises `KeyError` without it —
[source](https://github.com/aws-samples/aws-secrets-manager-rotation-lambdas/blob/master/SecretsManagerRDSPostgreSQLRotationSingleUser/lambda_function.py).
`modules/postgres/main.tf` sets it purely for the Lambda's benefit; no other consumer in this repo
looks at it.

## Known gaps

- **`modules/redis`'s AUTH token and `modules/pgbouncer`'s stats-user credential are not
  rotated.** Only the ticket for this module ("enable rotation policy for **DB** credentials")
  scoped rotation to Postgres. AWS does not publish an equivalent turnkey SAR rotation app for
  ElastiCache AUTH tokens or for an arbitrary self-managed credential like PgBouncer's stats user;
  rotating either would mean a bespoke Lambda, which is out of scope here.
- **This module (`modules/secrets`) was written without an AWS account to apply it against.** The
  Serverless Application Repository deployment's parameter names (`functionName`, `endpoint`,
  `vpcSecurityGroupIds`, `vpcSubnetIds`) and output name (`RotationLambdaARN`) are AWS's
  long-published, documented contract for this exact SAR app — also the Terraform AWS provider's
  own official example for the `aws_serverlessapplicationrepository_cloudformation_stack`
  resource type uses this same app — but this is the same category of gap as
  `modules/pgbouncer/README.md`'s unverified `dnf install pgbouncer` and
  `modules/registry/README.md`'s untested cosign flow. If the first real `terraform apply` doesn't
  deploy the stack cleanly, check the stack's CloudFormation events
  (`aws cloudformation describe-stack-events --stack-name serverlessrepo-<name_prefix>-postgres-rotation`)
  before assuming the Terraform is wrong.
- **No per-service Postgres role exists yet**, so single-user rotation of the one master
  credential is the only strategy available — see `modules/postgres/README.md`'s and
  `docs/runbooks/postgres-conventions.md`'s "Known gaps." Once a per-service role exists,
  alternating-users rotation becomes possible and removes the brief connection-refused window
  single-user rotation has while `setSecret` is in flight.
- **No compute tier exists yet**, so "services read secrets at boot" can only be exercised
  manually today (the bastion `psql`/`aws secretsmanager get-secret-value` commands above), not
  through a deployed `apps/api`/`apps/realtime`/`apps/workers` reading its own environment. See
  "Injecting secrets into a running service" above for what's prepared ahead of that.
