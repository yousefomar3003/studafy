# --- Distributed tracing pipeline (ST-260) --------------------------------------------------------
#
# Two Fargate tasks, Terraform-owned directly, exactly the same shape as prometheus.tf/grafana.tf:
# an OTel collector that receives every span apps/api, apps/realtime and apps/workers emit
# (@studafy/observability's tracing.ts — AlwaysOnSampler, no head sampling) and makes the tail-
# sampling decision ST-260's acceptance criterion asks for ("sampled at 10% + always-on for
# errors" — see infra/docker/otel-collector/config.yaml's own tail_sampling policy), forwarding
# only the sampled traces on to Tempo for storage. Grafana's Tempo datasource (this module's
# grafana.tf, provisioned from infra/docker/grafana/provisioning/datasources/datasources.yml.tpl)
# is the read path. Both ride on `monitoring_enabled` — this ticket depends on ST-259, so "the
# monitoring plane exists" and "the tracing pipeline exists" are the same condition, not a second
# toggle.

resource "aws_cloudwatch_log_group" "otel_collector" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/otel-collector"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "otel_collector" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-otel-collector"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.otel_collector_cpu)
  memory                   = tostring(var.otel_collector_memory)
  execution_role_arn       = var.execution_role_arn
  # No task role: the collector's only outbound call is OTLP/HTTP to Tempo over the private Cloud
  # Map DNS name baked into its own image (infra/docker/otel-collector/config.yaml) — no AWS API
  # calls, so no IAM permissions needed at runtime, same as Prometheus.

  container_definitions = jsonencode([
    {
      name      = "otel-collector"
      image     = var.otel_collector_image
      essential = true
      portMappings = [
        { containerPort = var.otel_collector_port, protocol = "tcp", name = "otel-collector" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.otel_collector[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "otel-collector"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-otel-collector" }
}

resource "aws_ecs_service" "otel_collector" {
  count = var.monitoring_enabled ? 1 : 0

  name            = "${var.name_prefix}-otel-collector"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.otel_collector[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this["otel-collector"].arn
    container_name = "otel-collector"
    container_port = var.otel_collector_port
  }

  tags = { Name = "${var.name_prefix}-otel-collector" }
}

# --- Tempo (trace storage) ------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "tempo" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/tempo"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "tempo" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-tempo"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.tempo_cpu)
  memory                   = tostring(var.tempo_memory)
  execution_role_arn       = var.execution_role_arn
  # No task role, same reasoning as Prometheus: Tempo's local storage backend
  # (infra/docker/tempo/tempo.yaml) writes to Fargate's own ephemeral task storage, not S3, so
  # there is no AWS API surface for a task role to grant.
  ephemeral_storage {
    size_in_gib = var.tempo_storage_gb
  }

  container_definitions = jsonencode([
    {
      name      = "tempo"
      image     = var.tempo_image
      essential = true
      portMappings = [
        { containerPort = var.otel_collector_port, protocol = "tcp", name = "tempo-otlp" },
        { containerPort = 3200, protocol = "tcp", name = "tempo-query" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.tempo[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "tempo"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-tempo" }
}

resource "aws_ecs_service" "tempo" {
  count = var.monitoring_enabled ? 1 : 0

  name            = "${var.name_prefix}-tempo"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.tempo[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  # Two registrations, one Cloud Map service: aws_service_discovery_service supports only one
  # container_port per service_registries block, and the collector's OTLP write and Grafana's
  # query read both resolve "tempo.metrics.internal" — the OTLP port is the one that matters for
  # DNS-based discovery health (see discovery.tf), so it is the one registered here. Grafana's own
  # query traffic reaches the same task via the same DNS name on the query port directly; nothing
  # about MULTIVALUE A-record routing is port-specific.
  service_registries {
    registry_arn   = aws_service_discovery_service.this["tempo"].arn
    container_name = "tempo"
    container_port = var.otel_collector_port
  }

  tags = { Name = "${var.name_prefix}-tempo" }
}
