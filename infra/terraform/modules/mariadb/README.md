# `mariadb`

RDS MariaDB HA pair (Multi-AZ, automatic failover) for the ERPNext + Frappe Education plane
(`modules/erpnext`), plus its master credential in Secrets Manager. Structurally a mirror of
`../postgres` — read that module's README first for the shape this one repeats; this doc only
covers what's different.

## Why this instance has no fixed database

`modules/postgres` provisions one `database_name` every app connects to. This module does not,
because Frappe's own multi-tenancy model is "site-per-school": `bench new-site
<school>.erpnext.<env>.studafy.com` creates a **new MariaDB database and MariaDB user** at
site-creation time (`infra/deploy/scripts/erpnext-new-site.sh`), not at `terraform apply` time. One
RDS instance ends up holding many databases, one per school — storage and connection-count
headroom (`max_allocated_storage_gb`) should be sized against tenant count, not a single
application's data volume.

## Why MariaDB 10.11

Frappe (and therefore ERPNext + the Education app) requires MariaDB >= 10.3.x. 10.11 is an
RDS-supported LTS release comfortably inside that floor — not a deeply researched pin, the same
honesty gap `modules/postgres`'s own `engine_version`/`instance_class` defaults already carry.

## Known gaps

- **No automatic credential rotation.** `modules/secrets`' `rotation.tf` is wired specifically to
  `modules/postgres`'s connection secret (AWS's published
  `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda). AWS publishes an equivalent
  `SecretsManagerRDSMariaDBRotationSingleUser` blueprint if this becomes a real requirement — not
  wired here, since nothing in this ticket's acceptance criteria calls for it and it isn't free
  (a second rotation Lambda, its own subnet/security-group wiring).
- **Not exercised against a live AWS account** — validated with `terraform validate` and an
  offline `plan`, same caveat every module in this repo not yet applied for real carries.

## Usage

```hcl
module "mariadb" {
  source = "./modules/mariadb"
  count  = var.environment == "dev" ? 0 : 1

  name_prefix          = module.naming.name_prefix
  db_subnet_group_name = module.network.db_subnet_group_name
  security_group_ids   = [module.network.mariadb_security_group_id]
  port                 = var.mariadb_port
  instance_class       = var.mariadb_instance_class
  deletion_protection  = var.mariadb_deletion_protection
  skip_final_snapshot  = var.mariadb_skip_final_snapshot
}
```

## Inputs

| Name                                  | Type           | Default            | Description                                                             |
| ------------------------------------- | -------------- | ------------------ | ----------------------------------------------------------------------- |
| `name_prefix`                         | `string`       | —                  | Resource name prefix.                                                   |
| `db_subnet_group_name`                | `string`       | —                  | `module.network.db_subnet_group_name` (shared with `modules/postgres`). |
| `security_group_ids`                  | `list(string)` | —                  | `[module.network.mariadb_security_group_id]`.                           |
| `port`                                | `number`       | `3306`             | Must match the network module's `mariadb_port`.                         |
| `engine_version`                      | `string`       | `10.11`            | Must be a `10.11.x` release (parameter group family is fixed).          |
| `instance_class`                      | `string`       | `db.t4g.micro`     | Unresearched sizing placeholder — see "Known gaps".                     |
| `allocated_storage_gb`                | `number`       | `20`               | RDS gp3 minimum.                                                        |
| `max_allocated_storage_gb`            | `number`       | `100`              | Autoscaling ceiling — size against tenant count.                        |
| `master_username`                     | `string`       | `studafy_admin`    | Not `admin`/`root`.                                                     |
| `max_statement_time_seconds`          | `number`       | `30`               | MariaDB's own unit (seconds, not ms).                                   |
| `slow_query_log_threshold_seconds`    | `number`       | `1`                | `long_query_time`.                                                      |
| `backup_retention_days`               | `number`       | `7`                | 0-35.                                                                   |
| `backup_window`, `maintenance_window` | `string`       | see `variables.tf` | Must not overlap.                                                       |
| `auto_minor_version_upgrade`          | `bool`         | `true`             |                                                                         |
| `apply_immediately`                   | `bool`         | `false`            | Leave `false` in staging/prod.                                          |
| `deletion_protection`                 | `bool`         | `false`            | Override `true` in staging/prod.tfvars.                                 |
| `skip_final_snapshot`                 | `bool`         | `false`            | Override `true` for disposable environments.                            |

## Outputs

| Name                    | Description                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `db_instance_id`        | RDS identifier.                                                                             |
| `address`               | Write endpoint (host only).                                                                 |
| `connection_secret_arn` | Secrets Manager ARN (host/port/username/password/tls). Password never a `terraform output`. |
