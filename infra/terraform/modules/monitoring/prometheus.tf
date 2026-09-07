# --- Prometheus (ST-259) ------------------------------------------------------------------------
#
# One Fargate task, Terraform-owned directly (aws_ecs_task_definition/aws_ecs_service here, not
# infra/deploy/scripts/deploy.sh's JSON-template path) — the same "static infra, not an app-deploy
# artifact with a CI-pushed IMAGE_TAG" reasoning modules/erpnext's own ECS resources already use.
# Every resource below is `count = var.monitoring_enabled ? 1 : 0` so dev (and any environment that
# doesn't want the stack) simply omits it, matching probe_enabled's own convention in main.tf.

resource "aws_cloudwatch_log_group" "prometheus" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/prometheus"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "prometheus" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-prometheus"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.prometheus_cpu)
  memory                   = tostring(var.prometheus_memory)
  execution_role_arn       = var.execution_role_arn
  # No task role: Prometheus's scrape-target discovery is DNS-based (discovery.tf), not an ECS API
  # call, so unlike a sidecar-discovery agent it needs zero AWS IAM permissions at runtime.
  ephemeral_storage {
    size_in_gib = var.prometheus_storage_gb
  }

  container_definitions = jsonencode([
    {
      name      = "prometheus"
      image     = var.prometheus_image
      essential = true
      environment = [
        { name = "PROMETHEUS_RETENTION", value = var.prometheus_retention },
      ]
      portMappings = [
        { containerPort = 9090, protocol = "tcp", name = "prometheus" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.prometheus[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "prometheus"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-prometheus" }
}

resource "aws_ecs_service" "prometheus" {
  count = var.monitoring_enabled ? 1 : 0

  name            = "${var.name_prefix}-prometheus"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.prometheus[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this["prometheus"].arn
    container_name = "prometheus"
    container_port = 9090
  }

  tags = { Name = "${var.name_prefix}-prometheus" }
}

# --- postgres_exporter (ST-259) -------------------------------------------------------------------
#
# Unconditional whenever monitoring_enabled is true — every environment provisions a Postgres
# instance (module.postgres), unlike MariaDB, which only exists behind the ERPNext plane.

resource "aws_cloudwatch_log_group" "postgres_exporter" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/postgres-exporter"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "postgres_exporter" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-postgres-exporter"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.exporter_cpu)
  memory                   = tostring(var.exporter_memory)
  execution_role_arn       = var.execution_role_arn

  container_definitions = jsonencode([
    {
      name = "postgres-exporter"
      # Official prometheus-community image, unmodified — no config file, only a DSN it reads
      # from DATA_SOURCE_NAME (the project's own documented contract). No custom Dockerfile needed
      # for a third-party image we don't layer anything onto, unlike prometheus/grafana above.
      image     = "prometheuscommunity/postgres-exporter:v0.20.1"
      essential = true
      secrets = [
        { name = "DATA_SOURCE_NAME", valueFrom = "${var.monitoring_secret_arn}:POSTGRES_EXPORTER_DSN::" },
      ]
      portMappings = [
        { containerPort = 9187, protocol = "tcp", name = "postgres-exporter" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.postgres_exporter[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "postgres-exporter"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-postgres-exporter" }
}

resource "aws_ecs_service" "postgres_exporter" {
  count = var.monitoring_enabled ? 1 : 0

  name            = "${var.name_prefix}-postgres-exporter"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.postgres_exporter[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this["postgres-exporter"].arn
    container_name = "postgres-exporter"
    container_port = 9187
  }

  tags = { Name = "${var.name_prefix}-postgres-exporter" }
}

# --- mysqld_exporter (ST-259, ERPNext plane only) -------------------------------------------------

resource "aws_cloudwatch_log_group" "mysqld_exporter" {
  count = var.monitoring_enabled && var.mariadb_exporter_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/mysqld-exporter"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "mysqld_exporter" {
  count = var.monitoring_enabled && var.mariadb_exporter_enabled ? 1 : 0

  family                   = "${var.name_prefix}-mysqld-exporter"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.exporter_cpu)
  memory                   = tostring(var.exporter_memory)
  execution_role_arn       = var.execution_role_arn

  container_definitions = jsonencode([
    {
      name = "mysqld-exporter"
      # Official prometheus/mysqld-exporter image, unmodified — same "just a DSN, no config file"
      # shape as postgres-exporter above. DATA_SOURCE_NAME is this project's own documented
      # contract too (a standard MySQL DSN: user:password@tcp(host:port)/).
      image     = "prom/mysqld-exporter:v0.20.0"
      essential = true
      secrets = [
        { name = "DATA_SOURCE_NAME", valueFrom = "${var.monitoring_secret_arn}:MYSQLD_EXPORTER_DSN::" },
      ]
      portMappings = [
        { containerPort = 9104, protocol = "tcp", name = "mysqld-exporter" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.mysqld_exporter[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "mysqld-exporter"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-mysqld-exporter" }
}

resource "aws_ecs_service" "mysqld_exporter" {
  count = var.monitoring_enabled && var.mariadb_exporter_enabled ? 1 : 0

  name            = "${var.name_prefix}-mysqld-exporter"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.mysqld_exporter[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this["mysqld-exporter"].arn
    container_name = "mysqld-exporter"
    container_port = 9104
  }

  tags = { Name = "${var.name_prefix}-mysqld-exporter" }
}
