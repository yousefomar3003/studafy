# `secrets`

Two independent things live here, both driven by acceptance criteria this ticket owns:

1. **Per-service application-secret containers** in Secrets Manager, one per `var.services` key,
   at the canonical path `"${name_prefix}/<service>/app-secrets"`, plus a read-only managed IAM
   policy per service scoped to exactly its own container and whatever shared data-tier secrets
   (`module.postgres`/`module.redis`/`module.pgbouncer`'s connection secrets) it's declared to
   need.
2. **Automatic rotation** of `module.postgres`'s master credential, via AWS's own published
   `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda, deployed from the Serverless
   Application Repository.

Secrets inventory (every secret in this repo's infrastructure, not just this module's own) and the
dev rotation runbook: [`docs/runbooks/secrets-conventions.md`](../../../../docs/runbooks/secrets-conventions.md).

## What this module does not do

- **It does not create a network or security group.** Pass `vpc_subnet_ids` and
  `security_group_ids` from `module.network` (`private_app_subnet_ids`,
  `secrets_rotation_security_group_id`) — same division of responsibility as every other module
  here.
- **It does not own `module.postgres`'s, `module.redis`'s or `module.pgbouncer`'s own connection
  secrets.** Those modules create and write their own secrets; this module only reads
  `postgres_connection_secret_arn` (to attach rotation) and whatever ARNs the root module passes
  into `services[*].shared_secret_arns` (to build IAM policies). It never duplicates their values.
- **It does not attach any IAM policy to a role.** No compute tier exists yet
  (`infra/terraform/README.md`'s status note), so there is no task role to attach to. This module
  produces standalone `aws_iam_policy` resources (`service_iam_policy_arns`); a future compute
  module attaches them by ARN.
- **It does not inject environment variables into a running container.** That's a property of
  whatever compute platform eventually exists (ECS's task-definition `secrets` block is the
  intended mechanism — see the runbook) — this module's job ends at "the secret exists at a
  canonical path and a scoped IAM policy exists to read it."
- **It does not rotate anything except the Postgres master credential.** `module.redis`'s AUTH
  token and `module.pgbouncer`'s stats-user credential have no rotation configured — see the
  runbook's "Known gaps."
- **It was not applied against a live AWS account.** The Serverless Application Repository
  deployment (`rotation.tf`) is built from AWS's long-published, documented contract for this
  exact SAR app (its parameter names are also the Terraform AWS provider's own official example
  for this resource type), not a guess — but this is the same honesty gap as
  `modules/pgbouncer`'s `dnf install` and `modules/registry`'s untested cosign flow. See the
  runbook for what to check if the first real apply doesn't go cleanly.

## Application secrets

`services` declares which service containers to create and which shared secrets each one's IAM
policy should also cover; `app_secret_values` supplies the actual values (sensitive, no default,
never in `*.tfvars` — see the variable's own description). A service present in `services` but
absent from `app_secret_values` still gets its container created, holding `"{}"` — the container
and its IAM policy exist as soon as this module is applied, ahead of an operator populating a real
value.

## Postgres rotation

`rotation.tf` deploys AWS's `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda into
`vpc_subnet_ids`/`security_group_ids` and attaches it to `postgres_connection_secret_arn` with
`aws_secretsmanager_secret_rotation`. Single-user strategy: the Lambda updates the same
`studafy_admin` row's password in place. No alternating-users strategy (which would have zero
connection-refused window during the swap) because that needs a second, less-privileged Postgres
role to clone between, and none exists yet
(`docs/runbooks/postgres-conventions.md`'s "Known gaps").

`aws_secretsmanager_secret_rotation` rotates the secret once immediately when the resource is
first created (`rotate_immediately = true`, made explicit rather than left to the provider
default) — in dev, that first `terraform apply` adding this resource **is** the "DB credential
rotation runbook executed once in dev" acceptance criterion. See the runbook for what to verify
afterwards.

`modules/postgres/main.tf`'s `aws_secretsmanager_secret_version.postgres` carries
`lifecycle { ignore_changes = [secret_string] }` specifically because of this module: once
rotation is attached, the Lambda writes the live password directly via `PutSecretValue`, and
without `ignore_changes` the next `terraform apply` would silently revert it to the original
seed password.

## Usage

```hcl
module "secrets" {
  source = "./modules/secrets"

  name_prefix = module.naming.name_prefix

  services = {
    api      = { shared_secret_arns = [module.pgbouncer.connection_secret_arn] }
    realtime = { shared_secret_arns = [module.redis.auth_secret_arn] }
    workers  = { shared_secret_arns = [module.redis.auth_secret_arn, module.pgbouncer.connection_secret_arn] }
  }
  app_secret_values = var.secrets_app_secret_values

  postgres_connection_secret_arn = module.postgres.connection_secret_arn
  postgres_rotation_days         = var.postgres_rotation_days

  vpc_subnet_ids     = module.network.private_app_subnet_ids
  security_group_ids = [module.network.secrets_rotation_security_group_id]
}
```

## Inputs

| Name                             | Type                                  | Default | Description                                                                       |
| -------------------------------- | ------------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `name_prefix`                    | `string`                              | —       | Resource name prefix, from `module.naming.name_prefix`.                           |
| `services`                       | `map(object({ shared_secret_arns }))` | —       | One app-secrets container per key; see "Application secrets" above.               |
| `app_secret_values`              | `map(map(string))`, sensitive         | `{}`    | Real values, never in `*.tfvars` — supply via `TF_VAR_secrets_app_secret_values`. |
| `postgres_connection_secret_arn` | `string`                              | —       | `module.postgres.connection_secret_arn`. Rotation attaches to this exact secret.  |
| `postgres_rotation_days`         | `number`                              | `30`    | Days between automatic rotations.                                                 |
| `vpc_subnet_ids`                 | `list(string)`                        | —       | `module.network.private_app_subnet_ids` — needs a NAT route.                      |
| `security_group_ids`             | `list(string)`                        | —       | `[module.network.secrets_rotation_security_group_id]`.                            |

## Outputs

| Name                           | Description                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `service_secret_arns`          | Map of service name -> its own app-secrets container ARN.                             |
| `service_iam_policy_arns`      | Map of service name -> managed IAM policy ARN, ready to attach to a future task role. |
| `postgres_rotation_lambda_arn` | ARN of the deployed rotation Lambda.                                                  |
| `postgres_rotation_enabled`    | Whether AWS reports rotation as enabled, per `aws_secretsmanager_secret_rotation`.    |
