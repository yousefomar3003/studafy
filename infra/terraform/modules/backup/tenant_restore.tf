# IAM for infra/tools/tenant-restore (ST-267): restoring a backup to a scratch instance and
# extracting a single school_id slice for "school deleted data" recovery, without a global
# point-in-time rollback of the whole Postgres instance.
#
# This module owns only the IAM identity the tooling assumes -- restore_verify.tf's scratch-
# instance mechanism (RestoreDBInstanceToPointInTime / wait / describe / delete) is reused by
# infra/tools/tenant-restore/restore-scratch.sh directly via the AWS CLI, not by a second ECS task
# definition here. Unlike the weekly automated drill, tenant-slice extraction is a human-reviewed,
# multi-step recovery an operator drives interactively (assume-role, restore, extract, review,
# apply) -- there is no unattended schedule to run it on, so no aws_scheduler_schedule exists in
# this file, deliberately.
#
# Restricted by construction, the same way main.tf's aws_iam_role.backup_service is: this role is
# created at all only when var.tenant_restore_operator_principal_arns is non-empty. An environment
# that never sets that variable has nobody who can assume it -- "restricted" starts from zero
# access, not from a broad grant narrowed after the fact.
locals {
  tenant_restore_operator_enabled = length(var.tenant_restore_operator_principal_arns) > 0

  # A distinct scratch-instance identifier prefix from restore_verify.tf's own
  # "${name_prefix}-pg-verify-*" (see restore_verify.tf's own comment on why that one is
  # wildcarded) -- restore-scratch.sh's default --name-prefix is "tenant-restore", not "pg-verify",
  # specifically so this tool's IAM scope and the automated drill's IAM scope never overlap: a
  # credential compromised through one cannot restore, delete, or collide with a scratch instance
  # the other tool created.
  tenant_restore_scratch_instance_arn_pattern = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${var.name_prefix}-tenant-restore-*"
}

data "aws_iam_policy_document" "tenant_restore_operator_trust" {
  count = local.tenant_restore_operator_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = var.tenant_restore_operator_principal_arns
    }

    # MFA is required to assume this role at all, not merely recommended -- a tenant-slice restore
    # reads a school's complete row set (including tables an ordinary admin session cannot fully
    # see, per infra/tools/tenant-restore/README.md's "Known gaps") and can write it back into a
    # live database. That is exactly the class of action this repo's own DR runbooks already treat
    # as needing a credential outside normal day-to-day blast radius (see
    # docs/runbooks/dr/ransomware-immutable-vault-restore.md's break-glass discussion) -- this is
    # the one place in this module where that idea is actually implemented, not just named as a gap.
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role" "tenant_restore_operator" {
  count = local.tenant_restore_operator_enabled ? 1 : 0

  name                 = "${var.name_prefix}-tenant-restore-operator"
  description          = "Assumed (MFA required) by an operator running infra/tools/tenant-restore against ${var.postgres_db_instance_id}. Restore/delete rights are scoped to that tool's own scratch-instance naming prefix only, never to the source instance's own lifecycle."
  assume_role_policy   = data.aws_iam_policy_document.tenant_restore_operator_trust[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "tenant_restore_operator" {
  count = local.tenant_restore_operator_enabled ? 1 : 0

  # Same reasoning as restore_verify.tf's own DescribeRds statement: RDS Describe* actions have no
  # resource-level restriction to scope down to.
  statement {
    sid       = "DescribeRds"
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = ["*"]
  }

  statement {
    sid    = "RestoreScratchInstance"
    effect = "Allow"
    actions = [
      "rds:RestoreDBInstanceToPointInTime",
      "rds:AddTagsToResource",
    ]
    resources = [
      local.postgres_instance_arn,                       # the source being restored from
      local.tenant_restore_scratch_instance_arn_pattern, # the target being created
      "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subgrp:${var.postgres_db_subnet_group_name}",
    ]
  }

  statement {
    sid       = "DeleteScratchInstance"
    effect    = "Allow"
    actions   = ["rds:DeleteDBInstance"]
    resources = [local.tenant_restore_scratch_instance_arn_pattern]
  }

  # Read only -- the same master credential restore_verify.tf's task role already reads. This
  # policy grants no write/rotate action on the secret itself.
  statement {
    sid       = "ReadPostgresCredential"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.postgres_connection_secret_arn]
  }

  # A dedicated prefix, distinct from restore_verify.tf's "reports/postgres/restore-verify/*" --
  # every extracted slice and its manifest.json audit record lands here
  # (infra/tools/tenant-restore/extract-tenant-slice.sh's REPORT_BUCKET/REPORT_PREFIX), and nothing
  # else in this bucket is readable or writable by this role.
  statement {
    sid    = "SliceAuditTrail"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
    ]
    resources = ["${var.backups_archive_bucket_arn}/tenant-restore/*"]
  }
}

resource "aws_iam_role_policy" "tenant_restore_operator" {
  count = local.tenant_restore_operator_enabled ? 1 : 0

  name   = "tenant-restore"
  role   = aws_iam_role.tenant_restore_operator[0].id
  policy = data.aws_iam_policy_document.tenant_restore_operator[0].json
}
