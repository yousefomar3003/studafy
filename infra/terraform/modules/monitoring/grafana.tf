# --- Grafana (ST-259) -----------------------------------------------------------------------------
#
# One Fargate task, Terraform-owned directly, same reasoning as prometheus.tf. No persistent
# volume for Grafana's own SQLite state (users, sessions, UI preferences) — see this module's
# README's "What this module does not do": dashboards are provisioned from files (dashboards-as-
# code, read-only — allowUiUpdates: false in infra/docker/grafana/provisioning/dashboards/
# dashboards.yml), so the only state actually lost on a task replacement is which admin session
# was logged in, not any dashboard content.

resource "aws_cloudwatch_log_group" "grafana" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/grafana"
  retention_in_days = var.log_retention_days
}

# Grafana's CloudWatch datasource (infra/docker/grafana/provisioning/datasources/
# datasources.yml.tpl) calls the CloudWatch API itself, from inside the container — that needs a
# task role, unlike Prometheus/the exporters, which make no AWS API calls at all.
resource "aws_iam_role" "grafana_task" {
  count = var.monitoring_enabled ? 1 : 0

  name        = "${var.name_prefix}-grafana-task"
  description = "Runtime role for Grafana's CloudWatch datasource (GetMetricData/ListMetrics/DescribeAlarms, read-only)."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# Read-only and metric/alarm-scoped — no logs:*, no describe-instances-style EC2/RDS metadata
# calls. This is exactly what the "CloudWatchReadOnlyAccess" AWS-managed policy grants too, but a
# hand-written statement here keeps the grant legible next to the one datasource that uses it,
# rather than an operator having to go look up what a managed-policy ARN actually contains.
data "aws_iam_policy_document" "grafana_cloudwatch_read" {
  statement {
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmsForMetric",
      "logs:DescribeLogGroups",
      "tag:GetResources",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "grafana_cloudwatch_read" {
  count = var.monitoring_enabled ? 1 : 0

  name   = "cloudwatch-read"
  role   = aws_iam_role.grafana_task[0].id
  policy = data.aws_iam_policy_document.grafana_cloudwatch_read.json
}

resource "aws_ecs_task_definition" "grafana" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-grafana"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.grafana_cpu)
  memory                   = tostring(var.grafana_memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.grafana_task[0].arn

  container_definitions = jsonencode([
    {
      name      = "grafana"
      image     = var.grafana_image
      essential = true
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        # GF_SECURITY_ADMIN_USER left at Grafana's own default ("admin") — only the password is
        # a secret worth injecting.
        { name = "GF_SERVER_ROOT_URL", value = "http://grafana.metrics.internal:${var.grafana_port}" },
      ]
      secrets = [
        { name = "GF_SECURITY_ADMIN_PASSWORD", valueFrom = "${var.monitoring_secret_arn}:GRAFANA_ADMIN_PASSWORD::" },
      ]
      portMappings = [
        { containerPort = var.grafana_port, protocol = "tcp", name = "grafana" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.grafana[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "grafana"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-grafana" }
}

resource "aws_ecs_service" "grafana" {
  count = var.monitoring_enabled ? 1 : 0

  name            = "${var.name_prefix}-grafana"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.grafana[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this["grafana"].arn
    container_name = "grafana"
    container_port = var.grafana_port
  }

  tags = { Name = "${var.name_prefix}-grafana" }
}
