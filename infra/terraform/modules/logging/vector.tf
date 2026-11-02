# --- Vector -------------------------------------------------------------------------------
#
# The collector tier. Terraform-owned Fargate, this repo's own image (infra/docker/vector.Dockerfile
# layering infra/docker/vector/vector.yaml onto the upstream timberio/vector image). Scales
# horizontally with no coordination: the aws_s3 source is driven by the shared SQS ingest queue, so
# adding a task just adds a consumer. SQS at-least-once redelivery can double-send an object on a
# visibility-timeout miss; Loki collapses identical (labels, timestamp, line) entries on ingest, so
# a redelivered batch is idempotent in the hot store, and the security sink keys objects by
# batch-flush time + a uuid so a re-put lands as a new immutable object rather than colliding.
#
# Firehose has already unwrapped the CloudWatch envelope (ingest.tf's DataMessageExtraction), so
# each S3 object is newline-delimited raw log lines. What Vector does to each (full VRL in
# vector.yaml):
#   1. parse the line as JSON (the app's NDJSON line per SAD §28); keep raw + flag on failure
#   2. derive labels — service (`.service`, default "api"), tenant (`.school_id`, or "none"),
#      env (`.env`, or var.environment), level (pino int -> name)
#   3. if the line carries `kind == "security"`, route a copy to the write-once S3 sink
#
# Whole-group security streams (the bastion SSH audit log) do NOT rely on this — ingest.tf's
# dedicated security Firehose writes those straight to the write-once bucket, no collector in the
# path. This sink is only for security events emitted as individual app log lines.
#
# Sinks: `loki` gets every line; `aws_s3` (security route only) gets the per-line write-once mirror.

resource "aws_cloudwatch_log_group" "vector" {
  name              = "/${var.name_prefix}/ecs/vector"
  retention_in_days = var.plane_log_retention_days
}

resource "aws_iam_role" "vector_task" {
  name        = "${var.name_prefix}-vector-task"
  description = "Runtime role for Vector: drain the ingest queue, read the archive bucket, write the security (write-once) bucket. Nothing else."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

data "aws_iam_policy_document" "vector_pipeline" {
  statement {
    sid    = "DrainIngestQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.ingest.arn]
  }

  statement {
    sid     = "ReadArchiveObjects"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:GetBucketLocation"]
    resources = [
      aws_s3_bucket.this["archive"].arn,
      "${aws_s3_bucket.this["archive"].arn}/*",
    ]
  }

  # PutObject only. The security bucket's Object-Lock default retention (storage.tf) is applied by
  # S3 automatically on write — no s3:PutObjectRetention needed, and deliberately not granted:
  # Vector must not be able to shorten a retention it just set.
  statement {
    sid       = "WriteSecurityMirror"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this["security"].arn}/*"]
  }
}

resource "aws_iam_role_policy" "vector_pipeline" {
  name   = "pipeline"
  role   = aws_iam_role.vector_task.id
  policy = data.aws_iam_policy_document.vector_pipeline.json
}

resource "aws_ecs_task_definition" "vector" {
  family                   = "${var.name_prefix}-vector"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.vector_cpu)
  memory                   = tostring(var.vector_memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.vector_task.arn

  container_definitions = jsonencode([
    {
      name      = "vector"
      image     = var.vector_image
      essential = true
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "VECTOR_DATA_DIR", value = "/tmp/vector" },
        { name = "VECTOR_INGEST_QUEUE_URL", value = aws_sqs_queue.ingest.url },
        { name = "VECTOR_LOKI_ENDPOINT", value = "http://loki.logging.internal:${var.loki_port}" },
        { name = "VECTOR_SECURITY_BUCKET", value = aws_s3_bucket.this["security"].id },
        { name = "VECTOR_ENV_FALLBACK", value = var.environment },
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O- http://127.0.0.1:8686/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.vector.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "vector"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-vector" }
}

resource "aws_ecs_service" "vector" {
  name            = "${var.name_prefix}-vector"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.vector.arn
  desired_count   = var.vector_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.logging_security_group_id]
    assign_public_ip = false
  }

  tags = { Name = "${var.name_prefix}-vector" }
}
