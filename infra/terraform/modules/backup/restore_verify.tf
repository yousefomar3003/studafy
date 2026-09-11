# Weekly (or, in dev, hand-run) Postgres restore-and-verify job (ST-265). The task definition is
# created in every environment, unconditionally — cheap, since a registered-but-never-run task
# definition costs nothing — so infra/deploy/scripts/postgres-restore-verify.sh can `aws ecs
# run-task` it by hand in dev for the "PITR to arbitrary timestamp demonstrated in dev" acceptance
# criterion. Only the recurring EventBridge Scheduler schedule at the bottom of this file is gated
# on var.automation_enabled, mirroring modules/erpnext's own site_setup task (inert task definition,
# always created; the thing that runs it is a script, not a service) for staging/prod's weekly runs.

resource "aws_cloudwatch_log_group" "postgres_restore_verify" {
  name              = "/${var.name_prefix}/ecs/backup-postgres-restore-verify"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "ecs_task_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "postgres_restore_verify_task" {
  name               = "${var.name_prefix}-backup-pg-restore-verify"
  description        = "ECS task role for the weekly Postgres restore-verify drill: restores a scratch instance from ${var.postgres_db_instance_id}, verifies it, deletes it."
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

locals {
  # The scratch instance's identifier is timestamped by the script at run time (postgres-restore-
  # verify.sh's $SCRATCH_ID = "${NAME_PREFIX}-pg-verify-<run-id>") — IAM can't know that value ahead
  # of time, so every scratch-instance-scoped statement below is wildcarded to this prefix rather
  # than a single literal ARN.
  postgres_scratch_instance_arn_pattern = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${var.name_prefix}-pg-verify-*"
  postgres_db_subnet_group_arn          = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subgrp:${var.postgres_db_subnet_group_name}"
}

data "aws_iam_policy_document" "postgres_restore_verify_task" {
  # postgres-restore-verify.sh's only Describe call is DescribeDBInstances (to read the scratch
  # instance's endpoint once available); `aws rds wait db-instance-available` polls that same API
  # under the hood, so no separate action is needed for it. This action has no meaningful
  # resource-level restriction (RDS Describe* actions operate account-wide by design — see AWS's own
  # IAM action reference), so "*" here is not a broadened grant, it's the only form it accepts.
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
      local.postgres_instance_arn,                 # the source being restored from
      local.postgres_scratch_instance_arn_pattern, # the target being created
      local.postgres_db_subnet_group_arn,
    ]
  }

  statement {
    sid       = "DeleteScratchInstance"
    effect    = "Allow"
    actions   = ["rds:DeleteDBInstance"]
    resources = [local.postgres_scratch_instance_arn_pattern]
  }

  statement {
    sid       = "ReadPostgresCredential"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.postgres_connection_secret_arn]
  }

  statement {
    sid       = "UploadReport"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${var.backups_archive_bucket_arn}/reports/postgres/restore-verify/*"]
  }
}

resource "aws_iam_role_policy" "postgres_restore_verify_task" {
  name   = "restore-verify"
  role   = aws_iam_role.postgres_restore_verify_task.id
  policy = data.aws_iam_policy_document.postgres_restore_verify_task.json
}

resource "aws_ecs_task_definition" "postgres_restore_verify" {
  family                   = "${var.name_prefix}-backup-pg-restore-verify"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.postgres_restore_verify_task.arn

  container_definitions = jsonencode([
    {
      name      = "restore-verify"
      image     = "${var.backup_verify_image_repository_url}:${var.backup_verify_image_tag}"
      essential = true
      command   = ["/home/app/postgres-restore-verify.sh"]
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "SOURCE_DB_INSTANCE_ID", value = var.postgres_db_instance_id },
        { name = "DB_SUBNET_GROUP_NAME", value = var.postgres_db_subnet_group_name },
        { name = "DB_SECURITY_GROUP_ID", value = var.postgres_db_security_group_id },
        { name = "POSTGRES_CONNECTION_SECRET_ARN", value = var.postgres_connection_secret_arn },
        { name = "REPORT_BUCKET", value = var.backups_archive_bucket_name },
        { name = "REPORT_PREFIX", value = "reports/postgres/restore-verify" },
        { name = "NAME_PREFIX", value = var.name_prefix },
        # RESTORE_TIME is deliberately absent here — infra/deploy/scripts/postgres-restore-verify.sh
        # sets it via a `run-task --overrides` container override for the dev PITR demo; the
        # schedule below never overrides it, so the weekly run always takes the latest restorable
        # time.
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.postgres_restore_verify.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "restore-verify"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-backup-pg-restore-verify" }
}

# --- Weekly schedule (automation_enabled only) --------------------------------------------------

data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count = var.automation_enabled ? 1 : 0

  name               = "${var.name_prefix}-backup-scheduler"
  description        = "Assumed by EventBridge Scheduler to run modules/backup's ECS tasks on a cron schedule."
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

data "aws_iam_policy_document" "scheduler_run_postgres_restore_verify" {
  statement {
    sid       = "RunTask"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = [replace(aws_ecs_task_definition.postgres_restore_verify.arn, "/:\\d+$/", ":*")]
  }

  statement {
    sid       = "PassTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [var.execution_role_arn, aws_iam_role.postgres_restore_verify_task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scheduler_run_postgres_restore_verify" {
  count = var.automation_enabled ? 1 : 0

  name   = "run-postgres-restore-verify"
  role   = aws_iam_role.scheduler[0].id
  policy = data.aws_iam_policy_document.scheduler_run_postgres_restore_verify.json
}

resource "aws_scheduler_schedule" "postgres_restore_verify" {
  count = var.automation_enabled ? 1 : 0

  name                = "${var.name_prefix}-backup-pg-restore-verify"
  schedule_expression = var.postgres_restore_verify_schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.cluster_arn
    role_arn = aws_iam_role.scheduler[0].arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.postgres_restore_verify.arn
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = var.private_app_subnet_ids
        security_groups  = [var.backup_security_group_id]
        assign_public_ip = false
      }
    }

    # ECS applies its own default retry/backoff for a transient RunTask failure; a real drill
    # failure (bad restore, failed verification) is a task exit code, not an API error, so
    # EventBridge Scheduler's own retry_policy is left at its default rather than doubling up on
    # ECS's retry semantics.
  }
}
