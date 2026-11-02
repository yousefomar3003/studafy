# Cross-region copy of the WAL-archiving-based continuous backup (ST-265). RDS backs
# backup_retention_period (modules/postgres, modules/mariadb) with continuous transaction-log
# archiving under the hood — that IS this project's "WAL archiving + daily base backups"; there is
# no separate WAL-E/pgBackRest process to stand up on top of a managed RDS instance, and doing so
# would fight the platform rather than use it. aws_db_instance_automated_backups_replication is the
# native mechanism for the "cross-region copy" half: it continuously ships that same continuous
# backup stream to var.dr_region, which is also what makes a real PITR restore possible *in* the DR
# region during an actual regional outage, not just a same-region drill.
#
# This resource represents the *destination* side of replication (the AWS API it wraps,
# StartDBInstanceAutomatedBackupsReplication, is called against the destination region) — hence
# `provider = aws.dr` throughout this file, the same cross-region-provider pattern module.cdn
# already uses for its us-east-1 ACM certificate.

resource "aws_kms_key" "dr_backup" {
  provider = aws.dr

  description             = "Encrypts cross-region replicated automated backups for ${var.name_prefix} in ${var.dr_region} (ST-265)."
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.dr_backup_key.json
}

resource "aws_kms_alias" "dr_backup" {
  provider = aws.dr

  name          = "alias/${var.name_prefix}-backup-replication"
  target_key_id = aws_kms_key.dr_backup.key_id
}

# Same "account-root administration statement AWS requires every key policy to carry" shape as
# modules/registry's signing_key policy, plus one statement letting the RDS service itself use the
# key — cross-region backup replication is performed by the RDS service on this account's behalf,
# not by an IAM role of ours, so the grantee is the service principal, not a role ARN.
data "aws_iam_policy_document" "dr_backup_key" {
  statement {
    sid    = "AccountRootAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "RdsCrossRegionBackupReplication"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
    actions = [
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_db_instance_automated_backups_replication" "postgres" {
  count = var.automation_enabled ? 1 : 0

  provider = aws.dr

  source_db_instance_arn = local.postgres_instance_arn
  kms_key_id             = aws_kms_key.dr_backup.arn
  retention_period       = var.postgres_backup_retention_days
}

resource "aws_db_instance_automated_backups_replication" "mariadb" {
  count = var.automation_enabled && var.erpnext_plane_enabled ? 1 : 0

  provider = aws.dr

  source_db_instance_arn = local.mariadb_instance_arn
  kms_key_id             = aws_kms_key.dr_backup.arn
  retention_period       = var.mariadb_backup_retention_days
}
