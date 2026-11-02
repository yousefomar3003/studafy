# `postgres`

Postgres 16 HA pair (RDS Multi-AZ: one primary + one non-readable synchronous standby, automatic
failover) plus its master credential and connection info in Secrets Manager. Parameter decisions
(`statement_timeout`, logging, `rds.force_ssl`) and the pgvector activation step are documented in
[`docs/runbooks/postgres-conventions.md`](../../../../docs/runbooks/postgres-conventions.md).

## What this module does not do

- **It does not create a network or security group.** Pass `db_subnet_group_name` and
  `security_group_ids` from `module.network` (`db_subnet_group_name`, `db_security_group_id`) —
  same division of responsibility as every other module here.
- **It does not run any SQL against the instance.** Terraform provisions the engine, not the
  schema. `CREATE EXTENSION vector;` and any migration are an application/operator step — see the
  linked runbook.
- **It does not provision compute to connect to Postgres.** No ECS/EC2 exists yet
  (`infra/terraform/README.md`), so "reachable from the app subnet only" can today be verified with
  a manual client from the bastion, not through a deployed `apps/api`.
- **It does not rotate the master credential.** That's `../secrets`'s job
  (`aws_secretsmanager_secret_rotation` attached to `connection_secret_arn`) — see
  [`docs/runbooks/secrets-conventions.md`](../../../../docs/runbooks/secrets-conventions.md). This
  module only carries the `lifecycle.ignore_changes` on `aws_secretsmanager_secret_version.postgres`
  that rotation requires (see `main.tf`), and the `"engine": "postgres"` key the rotation Lambda's
  secret schema needs — neither is consumed by anything in this module itself.

## Topology

One `aws_db_instance` with `multi_az = true` — RDS's standard HA form for Postgres: a primary plus
a synchronous standby in a second AZ that is not readable and exists solely to take over on
failover. This is a fixed choice (`multi_az` is not exposed as a variable), not a toggle: "HA pair"
is what this module provisions, in every environment, including dev — the acceptance criterion is
that failover is _tested_ in dev, which requires dev to actually have a standby to fail over to.

`rds.force_ssl = 1` in the parameter group rejects plaintext connections outright — there's no
existing plaintext consumer to migrate, so there's no transitional reason to allow one. Storage is
`gp3`, encrypted at rest with the AWS-managed `aws/rds` key (`storage_encrypted = true`; no
customer-managed KMS key is provisioned — same simplicity trade-off as `../redis`).

## Usage

```hcl
module "postgres" {
  source = "./modules/postgres"

  name_prefix           = module.naming.name_prefix
  db_subnet_group_name  = module.network.db_subnet_group_name
  security_group_ids    = [module.network.db_security_group_id]
  port                  = var.db_port
  instance_class        = var.postgres_instance_class
}
```

### Running the dev failover drill

```bash
aws rds reboot-db-instance \
  --db-instance-identifier "$(terraform output -raw postgres_db_instance_id)" \
  --force-failover

# Poll until the instance's status returns to "available", then confirm the standby AZ
# is now serving as primary:
aws rds describe-db-instances \
  --db-instance-identifier "$(terraform output -raw postgres_db_instance_id)" \
  --query 'DBInstances[0].[AvailabilityZone,SecondaryAvailabilityZone]'
```

A client connected via the instance's DNS endpoint (not a fixed node IP) reconnects to the new
primary automatically once RDS repoints it, the same reconnection model `../redis` relies on.

## Inputs

| Name                            | Type           | Default               | Description                                                                        |
| ------------------------------- | -------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `name_prefix`                   | `string`       | —                     | Resource name prefix, from `module.naming.name_prefix`.                            |
| `db_subnet_group_name`          | `string`       | —                     | `module.network.db_subnet_group_name`.                                             |
| `security_group_ids`            | `list(string)` | —                     | `[module.network.db_security_group_id]`.                                           |
| `port`                          | `number`       | `5432`                | Must match the network module's `db_port`.                                         |
| `engine_version`                | `string`       | `16.4`                | Must be a `16.x` release (parameter group family is hardcoded `postgres16`).       |
| `instance_class`                | `string`       | `db.t4g.micro`        | Dev-appropriate default only — no researched staging/prod sizing yet.              |
| `allocated_storage_gb`          | `number`       | `20`                  | Initial gp3 storage; 20 GB is RDS's Postgres minimum.                              |
| `max_allocated_storage_gb`      | `number`       | `100`                 | Storage-autoscaling ceiling; must be `>= allocated_storage_gb`.                    |
| `database_name`                 | `string`       | `studafy`             | Initial database created on the instance.                                          |
| `master_username`               | `string`       | `studafy_admin`       | Deliberately not `postgres`/`admin`.                                               |
| `statement_timeout_ms`          | `number`       | `30000`               | Server-side statement timeout; unresearched starting point, see runbook.           |
| `log_min_duration_statement_ms` | `number`       | `1000`                | Slow-query log threshold; `-1` disables it.                                        |
| `backup_retention_days`         | `number`       | `7`                   | Automated backup retention (0-35).                                                 |
| `backup_window`                 | `string`       | `03:00-05:00`         | Daily UTC backup window.                                                           |
| `maintenance_window`            | `string`       | `sun:05:00-sun:07:00` | Weekly UTC patching window.                                                        |
| `auto_minor_version_upgrade`    | `bool`         | `true`                | Apply engine minor-version patches automatically.                                  |
| `apply_immediately`             | `bool`         | `false`               | `false` in staging/prod — some changes trigger a failover.                         |
| `deletion_protection`           | `bool`         | `false`               | `true` in staging/prod.                                                            |
| `skip_final_snapshot`           | `bool`         | `false`               | `true` in dev; see the variable's own description for the destroy/recreate caveat. |

## Outputs

| Name                    | Description                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db_instance_id`        | For the failover drill CLI command above.                                                                                                               |
| `address`               | Write endpoint (host only, not sensitive on its own).                                                                                                   |
| `port`                  | Echoes `var.port`.                                                                                                                                      |
| `database_name`         | Echoes `var.database_name`.                                                                                                                             |
| `connection_secret_arn` | Secrets Manager ARN holding host/port/dbname/username/password/sslmode as JSON. Grant IAM read access; the password itself is never a Terraform output. |
| `parameter_group_name`  | Name of the applied `aws_db_parameter_group`.                                                                                                           |
