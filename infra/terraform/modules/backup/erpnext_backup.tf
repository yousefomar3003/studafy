# ERPNext/MariaDB plane: scheduled site + database backups, off-site retention, and a restore drill
# (ST-265). erpnext_plane_enabled only — every resource in this file is count-gated on it, mirroring
# module.mariadb/module.erpnext's own count in the root module. Reuses modules/erpnext's own bench
# image (infra/docker/erpnext.Dockerfile) and EFS access point rather than a dedicated image/volume —
# `bench backup`/`bench restore`/`bench doctor` are exactly the tools the backend/queue roles already
# ship, and the site data these tasks read/write only exists on that one shared `sites` filesystem.

locals {
  # frappe_docker's own base-image entrypoint (not overridden by infra/docker/erpnext.Dockerfile —
  # see its own header comment) patches common_site_config.json from these exact env vars before
  # exec'ing the container's command, the same way it does for the backend/websocket/queue/scheduler
  # roles in modules/erpnext/main.tf. Without this, `bench backup`/`bench restore` would run against
  # whatever stale config.json a site happened to have on disk, not this environment's real MariaDB.
  erpnext_bench_environment = var.erpnext_plane_enabled ? [
    { name = "DB_HOST", value = var.erpnext_mariadb_address },
    { name = "DB_PORT", value = tostring(var.erpnext_mariadb_port) },
    { name = "REDIS_CACHE", value = "redis://${var.erpnext_redis_primary_endpoint_address}:${var.erpnext_redis_port}/${var.erpnext_redis_cache_db}" },
    { name = "REDIS_QUEUE", value = "redis://${var.erpnext_redis_primary_endpoint_address}:${var.erpnext_redis_port}/${var.erpnext_redis_queue_db}" },
  ] : []

  erpnext_bench_secrets = var.erpnext_plane_enabled ? [
    { name = "DB_PASSWORD", valueFrom = "${var.erpnext_mariadb_connection_secret_arn}:password::" },
    { name = "REDIS_PASSWORD", valueFrom = "${var.erpnext_redis_auth_secret_arn}:auth_token::" },
  ] : []

  erpnext_site_hostnames_joined = join(" ", var.erpnext_site_hostnames)
}

resource "aws_cloudwatch_log_group" "erpnext_site_backup" {
  count = var.erpnext_plane_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/backup-erpnext-site-backup"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "erpnext_restore_drill" {
  count = var.erpnext_plane_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/backup-erpnext-restore-drill"
  retention_in_days = var.log_retention_days
}

# One role for both tasks, not two: both need exactly the same two permissions (read/write under
# backups-archive's erpnext/ prefix, read the MariaDB root credential), and splitting them would add
# a second near-identical policy document for no isolation benefit — the site-backup task simply
# never exercises the secretsmanager statement below.
resource "aws_iam_role" "erpnext_backup_task" {
  count = var.erpnext_plane_enabled ? 1 : 0

  name               = "${var.name_prefix}-backup-erpnext"
  description        = "ECS task role for the nightly ERPNext site-backup and monthly restore-drill tasks."
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

data "aws_iam_policy_document" "erpnext_backup_task" {
  # This file's header says every resource here is count-gated on erpnext_plane_enabled — this data
  # source was the one exception, missed because a `data` block still evaluates eagerly even though
  # it isn't a `resource`. Ungated, its ReadMariadbRootCredentialForDrill statement below references
  # var.erpnext_mariadb_connection_secret_arn, which is null whenever the ERPNext plane isn't
  # instantiated (dev) — found on dev's first real apply: "Null value found in list."
  count = var.erpnext_plane_enabled ? 1 : 0

  statement {
    sid       = "ListBackupsPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.backups_archive_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["erpnext/*", "reports/erpnext/*"]
    }
  }

  statement {
    sid    = "ReadWriteBackupsAndReports"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [
      "${var.backups_archive_bucket_arn}/erpnext/*",
      "${var.backups_archive_bucket_arn}/reports/erpnext/*",
    ]
  }

  # Only erpnext-restore-drill.sh uses this (bench new-site/restore/drop-site all need MariaDB root,
  # the same credential infra/deploy/scripts/erpnext-new-site.sh already pulls for the identical
  # reason) — erpnext-backup.sh never touches it, since DB_PASSWORD arrives via ECS `secrets`
  # injection (erpnext_bench_secrets above) using the execution role's existing "erpnext" service
  # policy, not this task role.
  statement {
    sid       = "ReadMariadbRootCredentialForDrill"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.erpnext_mariadb_connection_secret_arn]
  }
}

resource "aws_iam_role_policy" "erpnext_backup_task" {
  count = var.erpnext_plane_enabled ? 1 : 0

  name   = "erpnext-backup"
  role   = aws_iam_role.erpnext_backup_task[0].id
  policy = data.aws_iam_policy_document.erpnext_backup_task[0].json
}

# --- Nightly site + database backup --------------------------------------------------------------

resource "aws_ecs_task_definition" "erpnext_site_backup" {
  count = var.erpnext_plane_enabled ? 1 : 0

  family                   = "${var.name_prefix}-backup-erpnext-site-backup"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.erpnext_backup_task[0].arn

  volume {
    name = "sites"

    efs_volume_configuration {
      file_system_id     = var.erpnext_efs_file_system_id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = var.erpnext_efs_access_point_id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "site-backup"
      image     = "${var.erpnext_image_repository_url}:${var.erpnext_image_tag}"
      essential = true
      command   = ["bash", "erpnext-backup.sh"]
      environment = concat(local.erpnext_bench_environment, [
        { name = "SITE_HOSTNAMES", value = local.erpnext_site_hostnames_joined },
        { name = "REPORT_BUCKET", value = var.backups_archive_bucket_name },
      ])
      secrets = local.erpnext_bench_secrets
      mountPoints = [
        { sourceVolume = "sites", containerPath = "/home/frappe/frappe-bench/sites", readOnly = false }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.erpnext_site_backup[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "site-backup"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-backup-erpnext-site-backup" }
}

resource "aws_iam_role_policy" "scheduler_run_erpnext_site_backup" {
  count = var.automation_enabled && var.erpnext_plane_enabled ? 1 : 0

  name = "run-erpnext-site-backup"
  role = aws_iam_role.scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunTask"
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = replace(aws_ecs_task_definition.erpnext_site_backup[0].arn, "/:\\d+$/", ":*")
      },
      {
        Sid      = "PassTaskRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [var.execution_role_arn, aws_iam_role.erpnext_backup_task[0].arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_scheduler_schedule" "erpnext_site_backup" {
  count = var.automation_enabled && var.erpnext_plane_enabled ? 1 : 0

  name                = "${var.name_prefix}-backup-erpnext-site-backup"
  schedule_expression = var.erpnext_site_backup_schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.cluster_arn
    role_arn = aws_iam_role.scheduler[0].arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.erpnext_site_backup[0].arn
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = var.private_app_subnet_ids
        security_groups  = [var.erpnext_security_group_id]
        assign_public_ip = false
      }
    }
  }
}

# --- Monthly restore drill ------------------------------------------------------------------------

resource "aws_ecs_task_definition" "erpnext_restore_drill" {
  count = var.erpnext_plane_enabled ? 1 : 0

  family                   = "${var.name_prefix}-backup-erpnext-restore-drill"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.erpnext_backup_task[0].arn

  volume {
    name = "sites"

    efs_volume_configuration {
      file_system_id     = var.erpnext_efs_file_system_id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = var.erpnext_efs_access_point_id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "restore-drill"
      image     = "${var.erpnext_image_repository_url}:${var.erpnext_image_tag}"
      essential = true
      command   = ["bash", "erpnext-restore-drill.sh"]
      environment = concat(local.erpnext_bench_environment, [
        { name = "SITE_HOSTNAMES", value = local.erpnext_site_hostnames_joined },
        { name = "REPORT_BUCKET", value = var.backups_archive_bucket_name },
        { name = "MARIADB_CONNECTION_SECRET_ARN", value = var.erpnext_mariadb_connection_secret_arn },
      ])
      secrets = local.erpnext_bench_secrets
      mountPoints = [
        { sourceVolume = "sites", containerPath = "/home/frappe/frappe-bench/sites", readOnly = false }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.erpnext_restore_drill[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "restore-drill"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-backup-erpnext-restore-drill" }
}

resource "aws_iam_role_policy" "scheduler_run_erpnext_restore_drill" {
  count = var.automation_enabled && var.erpnext_plane_enabled ? 1 : 0

  name = "run-erpnext-restore-drill"
  role = aws_iam_role.scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunTask"
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = replace(aws_ecs_task_definition.erpnext_restore_drill[0].arn, "/:\\d+$/", ":*")
      },
      {
        Sid      = "PassTaskRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [var.execution_role_arn, aws_iam_role.erpnext_backup_task[0].arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_scheduler_schedule" "erpnext_restore_drill" {
  count = var.automation_enabled && var.erpnext_plane_enabled ? 1 : 0

  name                = "${var.name_prefix}-backup-erpnext-restore-drill"
  schedule_expression = var.erpnext_restore_drill_schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.cluster_arn
    role_arn = aws_iam_role.scheduler[0].arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.erpnext_restore_drill[0].arn
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = var.private_app_subnet_ids
        security_groups  = [var.erpnext_security_group_id]
        assign_public_ip = false
      }
    }
  }
}
