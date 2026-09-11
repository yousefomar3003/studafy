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

resource "aws_ecs_task_definition" "alertmanager" {
  count = var.monitoring_enabled ? 1 : 0

  family                   = "${var.name_prefix}-alertmanager"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.alertmanager_cpu)
  memory                   = tostring(var.alertmanager_memory)
  execution_role_arn       = var.execution_role_arn
  # No task role, for the same reason Prometheus has none: Alertmanager makes no AWS API calls. It
  # receives alerts over HTTP and POSTs them to the receiver URLs — the execution role's existing
  # secrets-read grant for the "monitoring" key is what resolves those URLs, and that happens
  # before the container starts, not from inside it.

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
      ]
      # The three receiver URLs. docker-entrypoint.sh materialises each into a 0600 file that
      # alertmanager.yml references as `url_file`, so no live paging URL is ever written into a
      # rendered config — see that script's header.
      secrets = [
        { name = "ALERTMANAGER_PAGE_URL", valueFrom = "${var.monitoring_secret_arn}:ALERTMANAGER_PAGE_URL::" },
        { name = "ALERTMANAGER_TICKET_URL", valueFrom = "${var.monitoring_secret_arn}:ALERTMANAGER_TICKET_URL::" },
        { name = "ALERTMANAGER_HEARTBEAT_URL", valueFrom = "${var.monitoring_secret_arn}:ALERTMANAGER_HEARTBEAT_URL::" },
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
# this task every five minutes, so a dead Alertmanager raises an incident at the on-call provider
# within ~5 minutes rather than being discovered during the next real outage. That is the mitigation
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
