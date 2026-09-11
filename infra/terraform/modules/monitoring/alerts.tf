# --- CloudWatch alarms and the Alertmanager bridge (ST-262) ---------------------------------------
#
# ## One catalog, three consumers
#
# `local.cloudwatch_alarms` is the single definition of every CloudWatch alarm this module creates.
# It feeds:
#
#   1. `aws_cloudwatch_metric_alarm.this` — the alarms themselves.
#   2. the bridge Lambda's `ALARM_CATALOG` — how each alarm becomes an Alertmanager alert.
#   3. `scripts/check-alert-rules.ts` — which reads the `alertname` values back out of this file and
#      fails CI if any of them has no matching section in the alert catalog runbook.
#
# Before this, each alarm was its own resource block with its own hand-written description and no
# severity at all (`alarm_actions = []`, "notification ownership still to be agreed" — this module's
# README). Collapsing them into one `for_each` is what makes "every alert has a severity and a
# runbook" a property of the type rather than a review comment: an entry missing `severity` or
# `alertname` is a plan-time error, because `each.value.severity` is not optional.
#
# `moved` blocks at the bottom of this file carry the existing alarms into the new addresses, so
# this refactor does not destroy and recreate live alarms.
#
# ## Why CloudWatch at all, when there is a Prometheus next door
#
# Because these signals are not visible to it, and cannot be made so without inventing an exporter
# for each. Fargate has no host to run `node_exporter` on; RDS replica lag and free storage are
# engine-level metrics AWS publishes and the database does not expose to a scraper on the writer;
# ACM certificate expiry has no metrics endpoint at all. The split is by *what can see the signal*,
# not by preference — and the bridge below is what stops that split from becoming two separate
# on-call experiences.

locals {
  # Where every alarm's runbook lives. One place, because the bridge derives each alert's
  # `runbook_url` from it plus the lowercased `alertname` (GitHub's own anchor rule for the
  # `### AlertName` headings in that file) rather than carrying 14 full URLs through a Lambda
  # environment that has a 4KB budget.
  runbook_base_url = "https://github.com/yousefomar3003/studafy/blob/main/docs/runbooks/alert-catalog.md"

  alertmanager_url = "http://alertmanager.metrics.internal:${var.alertmanager_port}"

  # Alarms are action-free wherever the monitoring plane does not exist (dev): there is no
  # Alertmanager to deliver to and no on-call rotation for that environment. They still evaluate,
  # so the dashboard shows their state — they simply notify nobody, which is what they already did
  # before this ticket.
  alarm_actions = var.monitoring_enabled ? [module.alert_topic[0].topic_arn] : []

  # --- The catalog ------------------------------------------------------------------------------
  #
  # Map key  = the alarm-name suffix, appended to `name_prefix`. Kebab-case, matching the names
  #            these alarms already had, so the `moved` blocks below are a rename of address only.
  # alertname= the CamelCase name the bridge presents to Alertmanager, and — lowercased — the
  #            runbook anchor. Several alarms deliberately share one `alertname` and differ by
  #            `service` (the three RDS CPU alarms, the three ECS CPU alarms, the two certificates):
  #            they are one operational question asked about several subjects, so they get one
  #            runbook section and Alertmanager groups them by `alertname` + `service`.
  # severity = critical | warning | info. Closed set; enforced by the precondition on the alarm
  #            resource below and by scripts/check-alert-rules.ts.
  # service  = the `service` label on the resulting alert. Also the inhibition key
  #            (infra/docker/alertmanager/alertmanager.yml's `equal`).
  #
  # `description` is the alarm's own `alarm_description`, which CloudWatch carries verbatim in the
  # notification and the bridge lifts into the alert's `summary`. It is written once, here.

  rds_cpu_alarms = {
    for name, id in local.rds_instances : "${name}-cpu-high" => {
      alertname           = "RdsCpuHigh"
      severity            = "warning"
      service             = name
      description         = "${name} CPU has exceeded 80 percent for 10 minutes."
      namespace           = "AWS/RDS"
      metric_name         = "CPUUtilization"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 80
      comparison_operator = "GreaterThanThreshold"
      treat_missing_data  = "missing"
      dimensions          = { DBInstanceIdentifier = id }
    }
  }

  ecs_cpu_alarms = {
    for service in local.ecs_services : "${service}-ecs-cpu-high" => {
      alertname           = "EcsServiceCpuHigh"
      severity            = "warning"
      service             = service
      description         = "${service} ECS CPU has exceeded 80 percent for 10 minutes."
      namespace           = "AWS/ECS"
      metric_name         = "CPUUtilization"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 80
      comparison_operator = "GreaterThanThreshold"
      treat_missing_data  = "missing"
      dimensions = {
        ClusterName = var.ecs_cluster_name
        ServiceName = "${var.name_prefix}-${service}"
      }
    }
  }

  data_plane_alarms = {
    # Two thresholds on one metric, the same two-tier shape the Prometheus queue and payment rules
    # use. 60s of lag degrades reporting freshness; 300s means the replica is not keeping up at all
    # and a reporting query is answering from yesterday.
    #
    # `treat_missing_data = "breaching"` on both: ReplicaLag stops being published when replication
    # *stops*, which is the worst case, not the quiet one.
    "postgres-replica-lag-high" = {
      alertname           = "PostgresReplicaLagHigh"
      severity            = "warning"
      service             = "postgres_read"
      description         = "PostgreSQL reporting replica lag has exceeded 60 seconds for 10 minutes."
      namespace           = "AWS/RDS"
      metric_name         = "ReplicaLag"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 60
      comparison_operator = "GreaterThanThreshold"
      treat_missing_data  = "breaching"
      dimensions          = { DBInstanceIdentifier = var.postgres_read_replica_instance_id }
    }

    "postgres-replica-lag-critical" = {
      alertname           = "PostgresReplicaLagCritical"
      severity            = "critical"
      service             = "postgres_read"
      description         = "PostgreSQL reporting replica lag has exceeded 5 minutes for 10 minutes; replication is not keeping up."
      namespace           = "AWS/RDS"
      metric_name         = "ReplicaLag"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 300
      comparison_operator = "GreaterThanThreshold"
      treat_missing_data  = "breaching"
      dimensions          = { DBInstanceIdentifier = var.postgres_read_replica_instance_id }
    }

    "postgres-storage-low" = {
      alertname           = "PostgresStorageLow"
      severity            = "warning"
      service             = "postgres"
      description         = "PostgreSQL free storage is below 10 GiB."
      namespace           = "AWS/RDS"
      metric_name         = "FreeStorageSpace"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 10737418240
      comparison_operator = "LessThanThreshold"
      treat_missing_data  = "missing"
      dimensions          = { DBInstanceIdentifier = var.postgres_instance_id }
    }

    "redis-engine-cpu-high" = {
      alertname           = "RedisCpuHigh"
      severity            = "warning"
      service             = "redis"
      description         = "Redis engine CPU has exceeded 75 percent for 10 minutes."
      namespace           = "AWS/ElastiCache"
      metric_name         = "EngineCPUUtilization"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 75
      comparison_operator = "GreaterThanThreshold"
      treat_missing_data  = "missing"
      dimensions          = { ReplicationGroupId = var.redis_replication_group_id }
    }
  }

  # The ST-149 synthetic probe's SLO alarm. Critical, unlike most of this file: it measures a
  # user-facing objective rather than a resource level, and it is apps/realtime's *only* SLO
  # (slo.yml explains why the HTTP burn-rate rules deliberately exclude that service). The ST-263
  # black-box probe alarms below (`synthetic_alarms`/`synthetic_alarms_dr`) are the same kind of
  # alarm for a different set of user-facing entry points — this is no longer the only one, just
  # the first. `treat_missing_data = "breaching"` because every successful run publishes a
  # datapoint every minute, so a wedged probe and a slow one are the same alarm — see this module's
  # README.
  probe_alarms = var.probe_enabled ? {
    "realtime-probe-latency-high" = {
      alertname           = "RealtimeProbeLatencyHigh"
      severity            = "critical"
      service             = "realtime"
      description         = "Realtime end-to-end propagation exceeded the ${var.probe_slo_ms}ms SLO, or the probe stopped reporting, for 2 consecutive minutes."
      namespace           = var.probe_metric_namespace
      metric_name         = "RealtimeProbeLatency"
      statistic           = "Maximum"
      period              = 60
      evaluation_periods  = 2
      threshold           = var.probe_slo_ms
      comparison_operator = "GreaterThanThreshold"
      treat_missing_data  = "breaching"
      dimensions          = {}
    }
  } : {}

  # --- Certificate expiry -----------------------------------------------------------------------
  #
  # Both ACM certificates are DNS-validated against Route 53 records Terraform itself creates, so
  # ACM renews them automatically and this should never fire. That is exactly why it is worth
  # alerting on: the failure mode is silent. If a validation CNAME is removed — a zone migration, a
  # hand-edited record, a `terraform destroy` of the wrong workspace — renewal fails quietly and the
  # first symptom is TLS errors for every user on the day the certificate lapses.
  #
  # Two thresholds because they mean different things. ACM begins renewal ~60 days out, so at 21
  # days something has already gone wrong and there is time to fix it calmly (warning); at 7 days
  # the remaining runway is shorter than a holiday weekend (critical).
  #
  # `treat_missing_data = "missing"`: ACM publishes DaysToExpiry once a day, and a certificate being
  # *replaced* briefly has no datapoints. Breaching would page on every legitimate rotation.
  certificate_alarms = {
    for pair in setproduct(
      [{ key = "edge", arn = var.edge_certificate_arn }],
      [
        { suffix = "expiring-soon", alertname = "CertificateExpiringSoon", severity = "warning", days = 21 },
        { suffix = "expiry-critical", alertname = "CertificateExpiryCritical", severity = "critical", days = 7 },
      ]
      ) : "${pair[0].key}-certificate-${pair[1].suffix}" => {
      alertname           = pair[1].alertname
      severity            = pair[1].severity
      service             = pair[0].key
      description         = "The ${pair[0].key} TLS certificate expires in under ${pair[1].days} days; ACM auto-renewal has not completed."
      namespace           = "AWS/CertificateManager"
      metric_name         = "DaysToExpiry"
      statistic           = "Minimum"
      period              = 86400
      evaluation_periods  = 1
      threshold           = pair[1].days
      comparison_operator = "LessThanThreshold"
      treat_missing_data  = "missing"
      dimensions          = { CertificateArn = pair[0].arn }
    }
  }

  # The CloudFront certificate, in us-east-1. Same shape, separate map and separate resource below,
  # because a CloudWatch alarm can only be created in the region its metric is published to and
  # Terraform cannot pick a provider per `for_each` key. Empty where there is no CDN (dev).
  certificate_alarms_us_east_1 = var.cdn_certificate_arn == null ? {} : {
    for entry in [
      { suffix = "expiring-soon", alertname = "CertificateExpiringSoon", severity = "warning", days = 21 },
      { suffix = "expiry-critical", alertname = "CertificateExpiryCritical", severity = "critical", days = 7 },
      ] : "cdn-certificate-${entry.suffix}" => {
      alertname           = entry.alertname
      severity            = entry.severity
      service             = "cdn"
      description         = "The CDN TLS certificate expires in under ${entry.days} days; ACM auto-renewal has not completed."
      namespace           = "AWS/CertificateManager"
      metric_name         = "DaysToExpiry"
      statistic           = "Minimum"
      period              = 86400
      evaluation_periods  = 1
      threshold           = entry.days
      comparison_operator = "LessThanThreshold"
      treat_missing_data  = "missing"
      dimensions          = { CertificateArn = var.cdn_certificate_arn }
    }
  }

  # --- Synthetic black-box probes (ST-263) ---------------------------------------------------
  #
  # Same "critical, user-facing objective" tier as probe_alarms above, one alarm per check per
  # region. `SyntheticCheckSuccess` is 1/0 per minute (synthetics.tf's header explains why the
  # Lambda always publishes rather than only on success), so `Average` falling below 1 over 2
  # consecutive minutes means at least one of that window's two runs failed; `treat_missing_data =
  # "breaching"` covers the Lambda itself not having run at all.
  #
  # Two maps, not one `for_each` over checks x regions, for the same reason certificate_alarms and
  # certificate_alarms_us_east_1 are two maps: a CloudWatch alarm can only be created in the region
  # its metric was published to, and Terraform cannot select a provider per `for_each` key. The `key`
  # (and therefore the alarm name) gets an explicit `-dr` suffix in the second map — synthetics.tf's
  # two Lambdas publish the *same* check names into two *different* regions' CloudWatch, so without
  # a distinct key the two regions' alarms would collide on one name and the bridge's alarm_catalog
  # below would have no way to tell an on-call engineer which region actually failed. `service`
  # carries the same suffix, since it is what becomes the alert's Alertmanager label.
  synthetic_alarms = var.synthetics_enabled ? {
    for check in local.synthetic_check_names : "synthetic-${check}-failing" => {
      alertname           = "SyntheticCheckFailing"
      severity            = "critical"
      service             = "synthetic-${check}"
      description         = "The synthetic black-box probe for '${check}' (region ${var.aws_region}) failed, or stopped reporting, for 2 consecutive minutes."
      namespace           = var.synthetics_metric_namespace
      metric_name         = "SyntheticCheckSuccess"
      statistic           = "Average"
      period              = 60
      evaluation_periods  = 2
      threshold           = 1
      comparison_operator = "LessThanThreshold"
      treat_missing_data  = "breaching"
      dimensions          = { Check = check }
    }
  } : {}

  synthetic_alarms_dr = var.synthetics_enabled ? {
    for check in local.synthetic_check_names : "synthetic-${check}-failing-dr" => {
      alertname           = "SyntheticCheckFailing"
      severity            = "critical"
      service             = "synthetic-${check}-dr"
      description         = "The synthetic black-box probe for '${check}' (region ${var.synthetics_dr_region}) failed, or stopped reporting, for 2 consecutive minutes."
      namespace           = var.synthetics_metric_namespace
      metric_name         = "SyntheticCheckSuccess"
      statistic           = "Average"
      period              = 60
      evaluation_periods  = 2
      threshold           = 1
      comparison_operator = "LessThanThreshold"
      treat_missing_data  = "breaching"
      dimensions          = { Check = check }
    }
  } : {}

  cloudwatch_alarms = merge(
    local.rds_cpu_alarms,
    local.ecs_cpu_alarms,
    local.data_plane_alarms,
    local.probe_alarms,
    local.synthetic_alarms,
    local.certificate_alarms,
  )

  # What the bridge needs and nothing more: the summary comes from the alarm's own description in
  # the notification, and the runbook URL is derived. Every region's alarms, since one Lambda
  # serves every topic.
  alarm_catalog = {
    for key, alarm in merge(local.cloudwatch_alarms, local.certificate_alarms_us_east_1, local.synthetic_alarms_dr) :
    "${var.name_prefix}-${key}" => {
      alertname = alarm.alertname
      severity  = alarm.severity
      service   = alarm.service
    }
  }

  allowed_severities = ["critical", "warning", "info"]
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.cloudwatch_alarms

  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison_operator
  treat_missing_data  = each.value.treat_missing_data
  dimensions          = each.value.dimensions

  # OK actions as well as alarm actions: the bridge translates an OK into a resolve, which is what
  # closes the incident at the on-call provider. Without it every page would have to be closed by
  # hand, and "is this still happening" would stop being answerable from the provider at all.
  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  lifecycle {
    precondition {
      condition     = contains(local.allowed_severities, each.value.severity)
      error_message = "Alarm '${each.key}' has severity '${each.value.severity}', which is not one of critical/warning/info. Alertmanager's routes (infra/docker/alertmanager/alertmanager.yml) match on exactly those three and have no catch-all, so a fourth value would be routed to the default receiver and read as a misconfiguration."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "us_east_1" {
  for_each = local.certificate_alarms_us_east_1
  provider = aws.us_east_1

  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison_operator
  treat_missing_data  = each.value.treat_missing_data
  dimensions          = each.value.dimensions

  alarm_actions = var.monitoring_enabled ? [module.alert_topic_us_east_1[0].topic_arn] : []
  ok_actions    = var.monitoring_enabled ? [module.alert_topic_us_east_1[0].topic_arn] : []

  lifecycle {
    precondition {
      condition     = contains(local.allowed_severities, each.value.severity)
      error_message = "Alarm '${each.key}' has a severity outside critical/warning/info — see aws_cloudwatch_metric_alarm.this's own precondition."
    }
  }
}

# The synthetics_dr_region twin of the synthetic-probe alarms already merged into
# aws_cloudwatch_metric_alarm.this above — same shape as aws_cloudwatch_metric_alarm.us_east_1,
# same reason (an alarm can only watch a metric published in its own region).
resource "aws_cloudwatch_metric_alarm" "synthetic_dr" {
  for_each = local.synthetic_alarms_dr
  provider = aws.dr

  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison_operator
  treat_missing_data  = each.value.treat_missing_data
  dimensions          = each.value.dimensions

  alarm_actions = var.monitoring_enabled ? [module.alert_topic_dr[0].topic_arn] : []
  ok_actions    = var.monitoring_enabled ? [module.alert_topic_dr[0].topic_arn] : []

  lifecycle {
    precondition {
      condition     = contains(local.allowed_severities, each.value.severity)
      error_message = "Alarm '${each.key}' has a severity outside critical/warning/info — see aws_cloudwatch_metric_alarm.this's own precondition."
    }
  }
}

# --- The bridge --------------------------------------------------------------------------------

data "archive_file" "alert_bridge" {
  type        = "zip"
  source_file = "${path.module}/lambda/cloudwatch-alert-bridge/index.mjs"
  output_path = "${path.module}/lambda/cloudwatch-alert-bridge/index.zip"
}

resource "aws_cloudwatch_log_group" "alert_bridge" {
  count = var.monitoring_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-alert-bridge"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "alert_bridge" {
  count = var.monitoring_enabled ? 1 : 0

  name               = "${var.name_prefix}-alert-bridge"
  description        = "Runtime role for the CloudWatch alarm -> Alertmanager bridge. Writes its own logs and manages its VPC ENI; nothing else."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Shared with the realtime probe in main.tf — one policy document, two roles, because the statement
# is identical and duplicating it would be two places to get a trust policy wrong.
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

# No AWS API calls beyond its own logs: it reads an SNS event the Lambda service hands it and POSTs
# over HTTP to a private DNS name. It does not describe alarms, read tags, or publish metrics — the
# catalog it needs arrives as an environment variable, which is why.
data "aws_iam_policy_document" "alert_bridge" {
  statement {
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      for group in aws_cloudwatch_log_group.alert_bridge : "${group.arn}:*"
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
}

resource "aws_iam_role_policy" "alert_bridge" {
  count = var.monitoring_enabled ? 1 : 0

  name   = "bridge-permissions"
  role   = aws_iam_role.alert_bridge[0].id
  policy = data.aws_iam_policy_document.alert_bridge.json
}

resource "aws_lambda_function" "alert_bridge" {
  count = var.monitoring_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-alert-bridge"
  description      = "Translates CloudWatch alarm state changes into Alertmanager alerts, so both alerting planes share one severity matrix and one set of receivers."
  role             = aws_iam_role.alert_bridge[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 15
  memory_size      = 128
  filename         = data.archive_file.alert_bridge.output_path
  source_code_hash = data.archive_file.alert_bridge.output_base64sha256

  # In the VPC because Alertmanager has no public endpoint by design — the monitoring security
  # group is the boundary. The group's own `monitoring_self` egress rule
  # (module.network) is what lets this reach alertmanager.metrics.internal, and its DNS egress is
  # what lets it resolve the name.
  vpc_config {
    subnet_ids         = var.private_app_subnet_ids
    security_group_ids = [var.monitoring_security_group_id]
  }

  environment {
    variables = {
      ALERTMANAGER_URL = local.alertmanager_url
      RUNBOOK_BASE_URL = local.runbook_base_url
      # Lambda's environment has a 4KB total budget, which is why this carries three short fields
      # per alarm rather than the full alert. ST-263 added ten entries (five checks x two regions)
      # on top of what was already here, which is enough to be worth saying plainly: at prod's full
      # alarm count (every optional alarm group enabled) this is roughly 3-3.5KB, not "comfortably
      # under 2KB" any more. It still fits, but there is materially less headroom than there was —
      # if the next addition pushes it over the limit, the answer is to move the catalog into the
      # deployment package as a generated file, not to trim what an on-call engineer sees.
      ALARM_CATALOG = jsonencode(local.alarm_catalog)
    }
  }
}

module "alert_topic" {
  source = "./modules/alert-topic"
  count  = var.monitoring_enabled ? 1 : 0

  name                 = "${var.name_prefix}-alerts"
  bridge_function_arn  = aws_lambda_function.alert_bridge[0].arn
  bridge_function_name = aws_lambda_function.alert_bridge[0].function_name
}

# The us-east-1 twin, subscribing the *same* Lambda across regions. Only instantiated where there is
# a CDN certificate to watch.
module "alert_topic_us_east_1" {
  source = "./modules/alert-topic"
  count  = var.monitoring_enabled && var.cdn_certificate_arn != null ? 1 : 0

  providers = {
    aws = aws.us_east_1
  }

  name                 = "${var.name_prefix}-alerts-us-east-1"
  bridge_function_arn  = aws_lambda_function.alert_bridge[0].arn
  bridge_function_name = aws_lambda_function.alert_bridge[0].function_name
}

# The synthetics_dr_region twin, same reasoning as alert_topic_us_east_1 — only instantiated where
# there are dr-region synthetic alarms to deliver (ST-263).
module "alert_topic_dr" {
  source = "./modules/alert-topic"
  count  = var.monitoring_enabled && var.synthetics_enabled ? 1 : 0

  providers = {
    aws = aws.dr
  }

  name                 = "${var.name_prefix}-alerts-dr"
  bridge_function_arn  = aws_lambda_function.alert_bridge[0].arn
  bridge_function_name = aws_lambda_function.alert_bridge[0].function_name
}

# --- State moves ---------------------------------------------------------------------------------
#
# The alarms below already exist in every applied environment; only their Terraform addresses
# change. Without these blocks the refactor would destroy and recreate each one — harmless in
# itself, but it would reset alarm history and, more to the point, would be a `terraform plan` that
# reads as "delete every alarm" to whoever reviews it.
#
# A `moved` block whose source is absent from state is a no-op, so the two conditional entries
# (mariadb, the probe) are safe to declare unconditionally.

moved {
  from = aws_cloudwatch_metric_alarm.rds_cpu["postgres"]
  to   = aws_cloudwatch_metric_alarm.this["postgres-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.rds_cpu["postgres_read"]
  to   = aws_cloudwatch_metric_alarm.this["postgres_read-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.rds_cpu["mariadb"]
  to   = aws_cloudwatch_metric_alarm.this["mariadb-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.ecs_cpu["api"]
  to   = aws_cloudwatch_metric_alarm.this["api-ecs-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.ecs_cpu["realtime"]
  to   = aws_cloudwatch_metric_alarm.this["realtime-ecs-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.ecs_cpu["workers"]
  to   = aws_cloudwatch_metric_alarm.this["workers-ecs-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.postgres_replica_lag
  to   = aws_cloudwatch_metric_alarm.this["postgres-replica-lag-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.postgres_storage
  to   = aws_cloudwatch_metric_alarm.this["postgres-storage-low"]
}

moved {
  from = aws_cloudwatch_metric_alarm.redis_cpu
  to   = aws_cloudwatch_metric_alarm.this["redis-engine-cpu-high"]
}

moved {
  from = aws_cloudwatch_metric_alarm.realtime_probe_latency[0]
  to   = aws_cloudwatch_metric_alarm.this["realtime-probe-latency-high"]
}
