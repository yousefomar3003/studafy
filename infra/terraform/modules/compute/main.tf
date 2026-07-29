# ECS Fargate cluster, one shared task-execution role, and the ALB target groups/listener rules
# module.edge's own README already anticipated. This module stops here — it does not create the
# api/realtime/workers ECS *services* (aws_ecs_service) or task definitions. That stays
# infra/deploy/scripts/deploy.sh's job: it already renders infra/deploy/ecs/<service>/*.json.tpl
# and calls `aws ecs create-service`/`update-service` directly, and was written and reviewed
# assuming exactly this baseline exists. Duplicating service ownership between Terraform and an
# imperative deploy script would mean two systems fighting over the same resource on every deploy.
# See infra/deploy/README.md's "Known gaps" #1-3, all closed by this module.

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${var.name_prefix}-cluster" }
}

# The three long-running services' task-definition templates already reference these exact group
# names (infra/deploy/ecs/*/task-definition.json.tpl's logConfiguration) — pre-created here with
# explicit retention, same convention as every other log group in this repo, rather than left to
# awslogs' implicit auto-create (which would need logs:CreateLogGroup on the execution role and
# inherit CloudWatch's no-expiry default).
resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["api", "realtime", "workers", "migrations"])

  name              = "/${var.name_prefix}/ecs/${each.key}"
  retention_in_days = var.log_retention_days
}

# --- Task execution role: shared across every ECS task in this cluster -------------------------

# Fargate's own control plane assumes this to pull the image and inject secrets/log config at task
# launch — distinct from a task *role*, which application code inside the container would assume
# to call AWS APIs itself. No service in this repo does that yet (infra/deploy/README.md's "Known
# gaps" #4), so this module creates no task roles.
data "aws_iam_policy_document" "execution_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  description        = "Shared ECS task execution role for ${var.name_prefix}: ECR pull, awslogs, and secrets injection at task launch."
  assume_role_policy = data.aws_iam_policy_document.execution_trust.json
}

# AWS-managed policy: ECR auth/pull + CreateLogStream/PutLogEvents on the log groups this task
# definition's own logConfiguration names. Covers the "pull the image, write the logs" half;
# secrets injection (below) is the half this policy does not cover.
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# One attachment per service's own module.secrets-scoped policy (api/realtime/workers/erpnext) —
# grants exactly the secretsmanager:GetSecretValue calls needed to resolve whichever ARNs a task
# definition's `secrets` array references. See variables.tf's secrets_service_iam_policy_arns.
resource "aws_iam_role_policy_attachment" "execution_secrets" {
  for_each = { for service, arn in var.secrets_service_iam_policy_arns : service => arn if service != "migrations" }

  role       = aws_iam_role.execution.name
  policy_arn = each.value
}

resource "aws_iam_role" "api_task" {
  name               = "${var.name_prefix}-api-task"
  description        = "Runtime role for API object-storage operations."
  assume_role_policy = data.aws_iam_policy_document.execution_trust.json
}

data "aws_iam_policy_document" "api_storage" {
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "${var.app_files_bucket_arn}/temp/*",
      "${var.app_files_bucket_arn}/permanent/*",
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.app_files_bucket_arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "api_storage" {
  name   = "${var.name_prefix}-api-storage"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_storage.json
}

resource "aws_iam_role" "workers_task" {
  name               = "${var.name_prefix}-workers-task"
  description        = "Runtime role for attendance report artifact uploads."
  assume_role_policy = data.aws_iam_policy_document.execution_trust.json
}

data "aws_iam_policy_document" "workers_reports" {
  statement {
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${var.app_files_bucket_arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "workers_reports" {
  name   = "${var.name_prefix}-workers-reports"
  role   = aws_iam_role.workers_task.id
  policy = data.aws_iam_policy_document.workers_reports.json
}

# The one-off migration task can resolve only the direct PostgreSQL credential. Keeping it off the
# shared application execution role prevents a migration task definition from selecting unrelated
# application, Redis, PgBouncer, or ERPNext secrets.
resource "aws_iam_role" "migrations_execution" {
  name               = "${var.name_prefix}-migrations-execution"
  description        = "ECS execution role for the one-off SQL migration task."
  assume_role_policy = data.aws_iam_policy_document.execution_trust.json
}

resource "aws_iam_role_policy_attachment" "migrations_execution_managed" {
  role       = aws_iam_role.migrations_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "migrations_secret" {
  role       = aws_iam_role.migrations_execution.name
  policy_arn = var.secrets_service_iam_policy_arns["migrations"]
}

# --- ALB target groups and listener rules -------------------------------------------------------

resource "aws_lb_target_group" "api" {
  name        = "${var.name_prefix}-api"
  port        = var.api_container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # Fargate awsvpc mode has no EC2 instance to register — targets are ENIs.

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = { Name = "${var.name_prefix}-api" }
}

resource "aws_lb_target_group" "realtime" {
  name        = "${var.name_prefix}-realtime"
  port        = var.realtime_container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  # Longer than api's: draining an in-flight WebSocket connection is not the same as draining a
  # request/response HTTP connection — give open sessions more time to finish/reconnect elsewhere
  # before the ALB stops sending them traffic during a deploy.
  deregistration_delay = 60

  tags = { Name = "${var.name_prefix}-realtime" }
}

# Priority order matters: /ws must be evaluated before the catch-all, since a listener rule with a
# lower priority number wins and rule evaluation stops at the first match.
resource "aws_lb_listener_rule" "realtime_ws" {
  listener_arn = var.https_listener_arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.realtime.arn
  }

  condition {
    path_pattern {
      # apps/realtime's actual handshake route (apps/realtime/src/app.ts: app.get("/ws", ...)) —
      # not a prefix guess. Health checks hit the target group directly, not through this rule.
      values = ["/ws"]
    }
  }
}

resource "aws_lb_listener_rule" "api_default" {
  listener_arn = var.https_listener_arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}
