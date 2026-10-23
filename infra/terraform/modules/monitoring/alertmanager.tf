# --- Alertmanager (ST-262) ------------------------------------------------------------------------
#
# The single place every alert in this system is routed, deduplicated, grouped and silenced —
# including the ones that do not come from Prometheus. Prometheus evaluates the rules baked into its
# own image (infra/docker/prometheus/rules/*.yml) and pushes what fires here; the CloudWatch alarms
# in alerts.tf reach the same place through the SNS bridge in that file, so there is one severity
# vocabulary, one set of receivers, one silence mechanism and one noisy-alert review queue rather
# than two parallel notification stacks that have to be kept in agreement by hand.
#
# One Fargate task, Terraform-owned directly, `count = var.monitoring_enabled` — the same shape and
# the same reasoning as prometheus.tf and grafana.tf beside it.

resource "aws_cloudwatch_log_group" "alertmanager" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/${var.name_prefix}/ecs/alertmanager"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "alertmanager_task" {
  count = var.monitoring_enabled ? 1 : 0

  name        = "${var.name_prefix}-alertmanager-task"
  description = "Runtime role for Alertmanager's SNS receivers: publish to the page/ticket/heartbeat topics, nothing else."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# Publish to exactly the three delivery topics, plus the data-key calls SNS makes against their
# KMS key on the publisher's behalf.
data "aws_iam_policy_document" "alertmanager_publish" {
  count = var.monitoring_enabled ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [for topic in aws_sns_topic.alert_delivery : topic.arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = [aws_kms_key.alert_delivery[0].arn]
  }
}

resource "aws_iam_role_policy" "alertmanager_publish" {
  count = var.monitoring_enabled ? 1 : 0

  name   = "sns-publish"
  role   = aws_iam_role.alertmanager_task[0].id
  policy = data.aws_iam_policy_document.alertmanager_publish[0].json
}

resource "aws_ecs_task_definition" "alertmanager" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-alertmanager"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.alertmanager_cpu)
  memory                   = tostring(var.alertmanager_memory)
  execution_role_arn       = var.execution_role_arn
  # Its receivers publish to the SNS topics in notifications.tf, from inside the container.
  task_role_arn = aws_iam_role.alertmanager_task[0].arn

  container_definitions = jsonencode([
    {
      name      = "alertmanager"
      image     = var.alertmanager_image
      essential = true
      environment = [
        # Alertmanager puts this in the notification payloads it sends, as the base for "view in
        # Alertmanager" links. It has no public endpoint (see the module README's access model), so
        # the link is only followable through the bastion port-forward — which is still more useful
        # than the container's own hostname, an ephemeral Fargate task id.
        { name = "ALERTMANAGER_EXTERNAL_URL", value = "http://alertmanager.metrics.internal:${var.alertmanager_port}" },
        # The three receivers' SNS topics (notifications.tf) and their region. Not secrets — an ARN
        # grants nothing, the topic policies do — so plain environment, rendered into
        # alertmanager.yml by docker-entrypoint.sh.
        { name = "ALERTMANAGER_SNS_REGION", value = var.aws_region },
        { name = "ALERTMANAGER_PAGE_TOPIC_ARN", value = aws_sns_topic.alert_delivery["page"].arn },
        { name = "ALERTMANAGER_TICKET_TOPIC_ARN", value = aws_sns_topic.alert_delivery["ticket"].arn },
        { name = "ALERTMANAGER_HEARTBEAT_TOPIC_ARN", value = aws_sns_topic.alert_delivery["heartbeat"].arn },
      ]
      portMappings = [
        { containerPort = var.alertmanager_port, protocol = "tcp", name = "alertmanager" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.alertmanager[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "alertmanager"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-alertmanager" }
}

# `desired_count = 1`, deliberately, and it is the one place this module accepts a single point of
# failure in the alerting path itself.
#
# Alertmanager's HA story is a gossip cluster of two or more peers that share notification state so
# a page is sent once rather than N times. On Fargate that needs a stable peer list, which
# `--cluster.peers` wants as addresses and which every task replacement invalidates. Running two
# unclustered replicas would be strictly worse than one: both would notify, so every page would
# arrive twice, and the second copy would train people to ignore the first.
#
# The exposure is bounded by the watchdog: the `Watchdog` alert (platform.yml) heartbeats through
# this task every five minutes, and notifications.tf's heartbeat alarm pages within ~15 minutes of
# it stopping, rather than a dead Alertmanager being discovered during the next real outage. That is the mitigation
# this trade rests on — if it is ever removed, this `desired_count` has to be revisited with it.
resource "aws_ecs_service" "alertmanager" {
  count = var.monitoring_enabled ? 1 : 0

  name            = "${var.name_prefix}-alertmanager"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.alertmanager[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.monitoring_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this["alertmanager"].arn
    container_name = "alertmanager"
    container_port = var.alertmanager_port
  }

  tags = { Name = "${var.name_prefix}-alertmanager" }
}
