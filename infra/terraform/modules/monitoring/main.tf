locals {
  ecs_services = toset(["api", "realtime", "workers"])
  rds_instances = merge(
    {
      postgres      = var.postgres_instance_id
      postgres_read = var.postgres_read_replica_instance_id
    },
    var.mariadb_instance_id == null ? {} : { mariadb = var.mariadb_instance_id },
  )

  # Widgets are the fixed operational set plus the probe's own latency widget when the probe is
  # enabled; concat lets each be added or dropped without touching the others' layout.
  operations_widgets = concat(
    [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "RDS CPU"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [for name, id in local.rds_instances : [
            "AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", id, { label = name }
          ]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Redis health"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "ReplicationGroupId", var.redis_replication_group_id],
            [".", "CurrConnections", ".", "."],
            [".", "Evictions", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 6
        properties = {
          title  = "ECS services"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = flatten([for service in local.ecs_services : [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", "${var.name_prefix}-${service}", { label = "${service} CPU" }],
            [".", "MemoryUtilization", ".", ".", ".", ".", { label = "${service} memory" }],
          ]])
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "PostgreSQL replica lag"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/RDS", "ReplicaLag", "DBInstanceIdentifier", var.postgres_read_replica_instance_id],
          ]
        }
      },
    ],
    var.probe_enabled ? [
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Realtime probe latency (SLO ${var.probe_slo_ms}ms)"
          region = var.aws_region
          stat   = "Maximum"
          period = 60
          metrics = [
            [var.probe_metric_namespace, "RealtimeProbeLatency", { label = "latency (ms)" }],
            # ANNOTATION_LINE paints the SLO threshold as a solid reference line; without it the
            # widget would need the reader to know the number in the title.
            [{ expression = "ANNOTATION_LINE(${var.probe_slo_ms}, 'SLO')", label = "SLO" }],
          ]
        }
      },
    ] : [],
  )
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  for_each = local.rds_instances

  alarm_name          = "${var.name_prefix}-${each.key}-cpu-high"
  alarm_description   = "${each.key} CPU has exceeded 80 percent for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { DBInstanceIdentifier = each.value }
}

resource "aws_cloudwatch_metric_alarm" "postgres_replica_lag" {
  alarm_name          = "${var.name_prefix}-postgres-replica-lag-high"
  alarm_description   = "PostgreSQL reporting replica lag has exceeded 60 seconds for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "ReplicaLag"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 60
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { DBInstanceIdentifier = var.postgres_read_replica_instance_id }
}

resource "aws_cloudwatch_metric_alarm" "postgres_storage" {
  alarm_name          = "${var.name_prefix}-postgres-storage-low"
  alarm_description   = "PostgreSQL free storage is below 10 GiB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10737418240
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { DBInstanceIdentifier = var.postgres_instance_id }
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${var.name_prefix}-redis-engine-cpu-high"
  alarm_description   = "Redis engine CPU has exceeded 75 percent for 10 minutes."
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 75
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = { ReplicationGroupId = var.redis_replication_group_id }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = local.ecs_services

  alarm_name          = "${var.name_prefix}-${each.key}-ecs-cpu-high"
  alarm_description   = "${each.key} ECS CPU has exceeded 80 percent for 10 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = []
  ok_actions          = []

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = "${var.name_prefix}-${each.key}"
  }
}

resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = "${var.name_prefix}-operations"
  dashboard_body = jsonencode({
    widgets = local.operations_widgets
  })
}

# --- Synthetic realtime probe (ST-149) ----------------------------------------------------------
# An EventBridge-scheduled probe Lambda measures realtime end-to-end propagation once a minute and
# publishes a single latency datapoint per run. Every resource here is `count = var.probe_enabled`
# so dev (and any environment without a realtime deployment) simply omits the probe; staging/prod
# pass probe_enabled = true. See lambda/realtime-probe/index.mjs for why the probe publishes to its
# own user room and emits no datapoint on failure.

data "archive_file" "realtime_probe" {
  type        = "zip"
  source_file = "${path.module}/lambda/realtime-probe/index.mjs"
  output_path = "${path.module}/lambda/realtime-probe/index.zip"
}

resource "aws_cloudwatch_log_group" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-realtime-probe"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  name               = "${var.name_prefix}-realtime-probe"
  assume_role_policy = data.aws_iam_policy_document.realtime_probe_assume_role.json
}

data "aws_iam_policy_document" "realtime_probe_assume_role" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

# The probe only needs read-connection material (two secrets), one metric namespace and its own
# log group plus the ENI plumbing the VPC attachment requires — nothing broader.
data "aws_iam_policy_document" "realtime_probe_permissions" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    # Comprehension (rather than [0]) so the policy is evaluable in environments where the probe
    # is disabled and the log group has count 0 — the empty resources list is harmless since the
    # policy is never attached there.
    resources = [
      for group in aws_cloudwatch_log_group.realtime_probe : "${group.arn}:*"
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface",
    ]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      var.realtime_jwt_secret_arn,
      var.redis_auth_secret_arn,
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "cloudwatch:PutMetricData",
    ]
    # Resource: the CloudWatch API grants PutMetricData against the namespace itself
    # (arn:aws:cloudwatch:::<account>:namespace/<name>); the Condition keeps the probe honest
    # about which namespace it can write, mirroring pgbouncer's PutMetricData policy.
    resources = [
      "arn:aws:cloudwatch:*:*:namespace/${var.probe_metric_namespace}",
    ]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.probe_metric_namespace]
    }
  }
}

resource "aws_iam_role_policy" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  name   = "probe-permissions"
  role   = aws_iam_role.realtime_probe[0].id
  policy = data.aws_iam_policy_document.realtime_probe_permissions.json
}

resource "aws_lambda_function" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-realtime-probe"
  role             = aws_iam_role.realtime_probe[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 30
  memory_size      = 128
  filename         = data.archive_file.realtime_probe.output_path
  source_code_hash = data.archive_file.realtime_probe.output_base64sha256

  # Runs in the private app tier (NAT for the ALB/WSS and CloudWatch egress) so it exercises the
  # same network boundary as the services it probes; Redis is reached via the app SG shared with
  # the services.
  vpc_config {
    subnet_ids         = var.probe_subnet_ids
    security_group_ids = var.probe_security_group_ids
  }

  environment {
    variables = {
      METRIC_NAMESPACE      = var.probe_metric_namespace
      WS_URL                = var.realtime_ws_url
      WS_JWT_SECRET_ARN     = var.realtime_jwt_secret_arn
      REDIS_AUTH_SECRET_ARN = var.redis_auth_secret_arn
      PROBE_SCHOOL_ID       = "probe"
      PROBE_USER_ID         = "probe"
      TIMEOUT_MS            = "8000"
    }
  }
}

resource "aws_cloudwatch_event_rule" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  name                = "${var.name_prefix}-realtime-probe"
  description         = "Triggers the synthetic realtime probe once a minute to measure propagation against the ${var.probe_slo_ms}ms SLO."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  rule = aws_cloudwatch_event_rule.realtime_probe[0].name
  arn  = aws_lambda_function.realtime_probe[0].arn
}

resource "aws_lambda_permission" "realtime_probe" {
  count = var.probe_enabled ? 1 : 0

  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.realtime_probe[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.realtime_probe[0].arn
}

# One SLO alarm: breaches the moment a run exceeds the SLO *or* the probe stops reporting
# (treat_missing_data = breaching covers a wedged/removed probe, since every successful run emits
# a datapoint every minute). Action-free like the other alarms until notification ownership lands.
resource "aws_cloudwatch_metric_alarm" "realtime_probe_latency" {
  count = var.probe_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-realtime-probe-latency-high"
  alarm_description   = "Realtime end-to-end propagation exceeded the ${var.probe_slo_ms}ms SLO, or the probe stopped reporting, for 2 consecutive minutes."
  namespace           = var.probe_metric_namespace
  metric_name         = "RealtimeProbeLatency"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.probe_slo_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = []
  ok_actions          = []
}
