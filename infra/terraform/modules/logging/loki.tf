# --- Loki -----------------------------------------------------------------------------------
#
# One Fargate task, Terraform-owned directly (like modules/monitoring's Prometheus/Grafana, not
# infra/deploy/scripts/deploy.sh's JSON-template path — this is static infra, not a CI-pushed
# app artifact). Runs this repo's own image (infra/docker/loki.Dockerfile), which layers
# infra/docker/loki/loki-config.yml.tpl onto the upstream grafana/loki image (LOKI_PORT,
# LOKI_CHUNKS_BUCKET, AWS_REGION, LOKI_RETENTION are envsubst'd in at container start).
#
# Single binary (`-target=all`), single replica, chunks and the TSDB index in S3. The only state
# on the task's ephemeral disk is working scratch (index download, compactor working dir), so a
# task replacement loses nothing that isn't already in the chunks bucket — the same "no persistent
# volume, and here it genuinely doesn't need one" position modules/monitoring took for Prometheus,
# except Loki's durable data really is offloaded rather than merely accepted as lost.

resource "aws_cloudwatch_log_group" "loki" {
  name              = "/${var.name_prefix}/ecs/loki"
  retention_in_days = var.plane_log_retention_days
}

# Loki reaches S3 with this role from inside the container (unlike Prometheus, which needs no AWS
# access at all). Scoped to the one chunks bucket; DeleteObject is required for the compactor to
# enforce var.loki_retention.
resource "aws_iam_role" "loki_task" {
  name        = "${var.name_prefix}-loki-task"
  description = "Runtime role for Loki's S3 chunk/index store (read/write/delete on the loki-chunks bucket only)."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

data "aws_iam_policy_document" "loki_chunks_rw" {
  statement {
    sid       = "ListChunksBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.this["chunks"].arn]
  }

  statement {
    sid    = "ReadWriteChunks"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.this["chunks"].arn}/*"]
  }
}

resource "aws_iam_role_policy" "loki_chunks_rw" {
  name   = "chunks-store"
  role   = aws_iam_role.loki_task.id
  policy = data.aws_iam_policy_document.loki_chunks_rw.json
}

resource "aws_ecs_task_definition" "loki" {
  family                   = "${var.name_prefix}-loki"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.loki_cpu)
  memory                   = tostring(var.loki_memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.loki_task.arn

  ephemeral_storage {
    size_in_gib = var.loki_storage_gb
  }

  container_definitions = jsonencode([
    {
      name      = "loki"
      image     = var.loki_image
      essential = true
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "LOKI_PORT", value = tostring(var.loki_port) },
        { name = "LOKI_CHUNKS_BUCKET", value = aws_s3_bucket.this["chunks"].id },
        { name = "LOKI_RETENTION", value = var.loki_retention },
      ]
      portMappings = [
        { containerPort = var.loki_port, protocol = "tcp", name = "loki" },
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O- http://127.0.0.1:${var.loki_port}/ready || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.loki.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "loki"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-loki" }
}

resource "aws_ecs_service" "loki" {
  name            = "${var.name_prefix}-loki"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.loki.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.logging_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.loki.arn
    container_name = "loki"
    container_port = var.loki_port
  }

  tags = { Name = "${var.name_prefix}-loki" }
}
