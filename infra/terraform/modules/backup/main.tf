# Monthly immutable, object-lock-equivalent snapshot (ST-265). AWS Backup Vault Lock is RDS's
# analogue of S3 Object Lock: once changeable_for_days elapses, no principal — including the
# account root — can delete a recovery point or remove the lock before vault_lock_min_retention_days
# has passed. Combined with granting no prod IAM identity (the master DB credentials, the ECS
# execution/task roles, the deploy_pull role) any backup:* permission anywhere in this repo, this is
# what "inaccessible with prod credentials" means here: not a second AWS account (none exists yet —
# see README.md's Known gaps), but a resource nothing in the day-to-day request path can reach even
# if it wanted to, made physically undeletable on top of that.
#
# Covers both database planes with one vault/plan/selection — a single Postgres+MariaDB instance
# list, not two near-identical vaults — because AWS Backup's job here (orchestrate + lock an
# RDS-native snapshot) is identical for both engines; only replication.tf's cross-region continuous
# backup and restore_verify.tf/erpnext_backup.tf's drills need engine-specific logic.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  postgres_instance_arn = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${var.postgres_db_instance_id}"
  mariadb_instance_arn  = var.erpnext_plane_enabled ? "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${var.mariadb_db_instance_id}" : null

  backup_selection_resources = compact([
    local.postgres_instance_arn,
    local.mariadb_instance_arn,
  ])
}

resource "aws_backup_vault" "monthly" {
  count = var.automation_enabled ? 1 : 0

  name = "${var.name_prefix}-monthly-locked"
}

# Compliance mode (not Governance): Governance still lets an account with the right IAM permission
# delete a recovery point via a "break-glass" override. Compliance has no override, for anyone,
# until min_retention_days elapses — that is the actual "immutable" guarantee the acceptance
# criterion asks for, not just "restricted by default".
resource "aws_backup_vault_lock_configuration" "monthly" {
  count = var.automation_enabled ? 1 : 0

  backup_vault_name = aws_backup_vault.monthly[0].name

  min_retention_days  = var.vault_lock_min_retention_days
  changeable_for_days = var.vault_lock_changeable_for_days
}

data "aws_iam_policy_document" "backup_service_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup_service" {
  count = var.automation_enabled ? 1 : 0

  name               = "${var.name_prefix}-backup-service"
  description        = "Assumed by the AWS Backup service to snapshot the Postgres/MariaDB instances this module's plan/selection name."
  assume_role_policy = data.aws_iam_policy_document.backup_service_trust.json
}

# AWS-managed: the exact set of rds:CreateDBSnapshot/DescribeDBInstances/... actions AWS Backup's
# own service needs, kept in sync by AWS itself rather than hand-maintained here.
resource "aws_iam_role_policy_attachment" "backup_service" {
  count = var.automation_enabled ? 1 : 0

  role       = aws_iam_role.backup_service[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "monthly" {
  count = var.automation_enabled ? 1 : 0

  name = "${var.name_prefix}-monthly-locked"

  rule {
    rule_name         = "monthly-locked-snapshot"
    target_vault_name = aws_backup_vault.monthly[0].name
    schedule          = var.backup_plan_monthly_schedule

    # delete_after == the lock's own floor: once a recovery point is old enough that the lock no
    # longer forbids deleting it, AWS Backup deletes it on schedule automatically. Without this,
    # every monthly snapshot accumulates forever — the same "versioning without cleanup is unbounded
    # growth" reasoning as modules/storage's noncurrent-version lifecycle rule.
    lifecycle {
      delete_after = var.vault_lock_min_retention_days
    }
  }
}

resource "aws_backup_selection" "monthly" {
  count = var.automation_enabled ? 1 : 0

  name         = "${var.name_prefix}-monthly-locked"
  plan_id      = aws_backup_plan.monthly[0].id
  iam_role_arn = aws_iam_role.backup_service[0].arn
  resources    = local.backup_selection_resources
}
