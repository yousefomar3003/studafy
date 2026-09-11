# --- Black-box synthetic availability probes (ST-263) ---------------------------------------------
#
# ## What this is
#
# One Lambda (lambda/synthetics-probe/index.mjs), deployed identically in two regions, scheduled
# once a minute, making five unauthenticated GETs against the app's public entry points: login
# page, /healthz, OAuth start, checkout page (mapped to /pricing — see the Lambda's own header
# comment for why), and invitation verify. Each check publishes its own
# SyntheticCheckSuccess/SyntheticCheckLatency datapoint; alerts.tf turns those into alarms and
# feeds them through the same Alertmanager bridge every other alarm in this module uses.
#
# ## Why two regions
#
# The application itself runs in exactly one region (var.aws_region) — there is no second
# deployment to fail over to. What a second *probing* region catches is different: a regional
# DNS-resolver, network-path, or CloudFront-POP problem that only affects traffic originating from
# (or routed through) one part of the world, which a probe running next to the application would
# never see (it never leaves that region's network boundary). That is the literal reading of the
# ticket's "per region" and "regional failure alerts" acceptance criteria — distinguishing "this
# region can't reach us" from "we are down everywhere" is the entire value of running it twice.
#
# The second region is `aws.dr` (var.backup_dr_region), the alias root providers.tf already
# maintains for module.backup's cross-region automated-backups replication — reused rather than
# adding a third provider alias for this alone. versions.tf's header carries the rest of that
# reasoning.
#
# ## Why no VPC
#
# Unlike the realtime probe (main.tf) and the alert bridge (alerts.tf), every target here is a
# public HTTPS endpoint reachable over the open internet — there is no private Redis connection or
# secret to read. A Lambda outside a VPC already has outbound internet access with no NAT and no
# ENI cold start, so adding one here would only add cost and latency for no benefit.
#
# ## Why one IAM role for two regions
#
# IAM is a global AWS service — a role has no region of its own, regardless of which provider
# created it. Creating `aws_iam_role.synthetics_probe` once (via the default provider) and handing
# its ARN to both the default-provider and the aws.dr Lambda functions below is therefore correct,
# not a shortcut, and is simpler than maintaining two identical roles that could drift apart.

locals {
  # One name per black-box check. This list, the dashboard widgets below, and alerts.tf's
  # synthetic_alarms/synthetic_alarms_dr locals all key off it, so a check can only be added or
  # removed in one place.
  synthetic_check_names = [
    "login-page",
    "healthz",
    "oauth-start",
    "checkout-page",
    "invitation-verify",
    # ai-health (ST-264): added so the public status page's `ai` component has the same shape of
    # automatic signal as every other component, rather than being the one nothing ever checks —
    # see lambda/synthetics-probe/index.mjs's header for why this is a cheap route check, not a
    # real Anthropic call.
    "ai-health",
  ]

  synthetics_probe_env = {
    METRIC_NAMESPACE = var.synthetics_metric_namespace
    WEB_ORIGIN       = var.web_origin
    API_ORIGIN       = var.api_origin
    TIMEOUT_MS       = "8000"
  }
}

data "archive_file" "synthetics_probe" {
  type        = "zip"
  source_file = "${path.module}/lambda/synthetics-probe/index.mjs"
  output_path = "${path.module}/lambda/synthetics-probe/index.zip"
}

resource "aws_iam_role" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  name        = "${var.name_prefix}-synthetics-probe"
  description = "Runtime role for the black-box synthetic probe Lambda (ST-263). Shared by both regional deployments — see this file's header for why one IAM role serves both."
  # Reuses alerts.tf's shared lambda.amazonaws.com trust policy document (identical to the one the
  # realtime probe and the alert bridge each already assume) rather than declaring a third copy of
  # the same statement.
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Its own logs (both regions' log groups) and PutMetricData scoped to its own namespace — nothing
# else. No VPC permissions (see header) and no secrets: every check is an unauthenticated public GET.
data "aws_iam_policy_document" "synthetics_probe_permissions" {
  statement {
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    # Comprehension over both regions' log groups (rather than indexing [0]) so the policy is
    # evaluable even when synthetics_enabled is false and both groups have count 0 — the empty
    # resources list is harmless since the policy is never attached there. Mirrors the realtime
    # probe's own reasoning in main.tf.
    resources = concat(
      [for group in aws_cloudwatch_log_group.synthetics_probe : "${group.arn}:*"],
      [for group in aws_cloudwatch_log_group.synthetics_probe_dr : "${group.arn}:*"],
    )
  }

  statement {
    effect  = "Allow"
    actions = ["cloudwatch:PutMetricData"]
    # Same shape as the realtime probe's PutMetricData statement in main.tf: the resource ARN
    # grants against the namespace itself, the condition keeps the grant scoped to exactly that
    # namespace. `*:*` for partition/region/account is required by the PutMetricData action's own
    # ARN format (a CloudWatch namespace has no account/region qualifier to match against) and is
    # what lets this one policy cover PutMetricData calls made from either region.
    resources = ["arn:aws:cloudwatch:*:*:namespace/${var.synthetics_metric_namespace}"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.synthetics_metric_namespace]
    }
  }
}

resource "aws_iam_role_policy" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  name   = "synthetics-probe-permissions"
  role   = aws_iam_role.synthetics_probe[0].id
  policy = data.aws_iam_policy_document.synthetics_probe_permissions.json
}

# --- Region 1: var.aws_region (default provider) --------------------------------------------------

resource "aws_cloudwatch_log_group" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-synthetics-probe"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-synthetics-probe"
  description      = "Black-box availability probe (ST-263): login page, /healthz, OAuth start, checkout page, invitation verify."
  role             = aws_iam_role.synthetics_probe[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 10
  memory_size      = 128
  filename         = data.archive_file.synthetics_probe.output_path
  source_code_hash = data.archive_file.synthetics_probe.output_base64sha256

  environment {
    variables = local.synthetics_probe_env
  }
}

resource "aws_cloudwatch_event_rule" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  name                = "${var.name_prefix}-synthetics-probe"
  description         = "Triggers the synthetic availability probe once a minute (region ${var.aws_region})."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  rule = aws_cloudwatch_event_rule.synthetics_probe[0].name
  arn  = aws_lambda_function.synthetics_probe[0].arn
}

resource "aws_lambda_permission" "synthetics_probe" {
  count = var.synthetics_enabled ? 1 : 0

  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.synthetics_probe[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.synthetics_probe[0].arn
}

# --- Region 2: synthetics_dr_region (aws.dr) — same code, same schedule, see header ----------------

resource "aws_cloudwatch_log_group" "synthetics_probe_dr" {
  count    = var.synthetics_enabled ? 1 : 0
  provider = aws.dr

  name              = "/aws/lambda/${var.name_prefix}-synthetics-probe"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "synthetics_probe_dr" {
  count    = var.synthetics_enabled ? 1 : 0
  provider = aws.dr

  function_name    = "${var.name_prefix}-synthetics-probe"
  description      = "Black-box availability probe (ST-263), the aws.dr regional twin of aws_lambda_function.synthetics_probe — identical code and checks, run from ${var.synthetics_dr_region} so a regional failure is distinguishable from a global one."
  role             = aws_iam_role.synthetics_probe[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 10
  memory_size      = 128
  filename         = data.archive_file.synthetics_probe.output_path
  source_code_hash = data.archive_file.synthetics_probe.output_base64sha256

  environment {
    variables = local.synthetics_probe_env
  }
}

resource "aws_cloudwatch_event_rule" "synthetics_probe_dr" {
  count    = var.synthetics_enabled ? 1 : 0
  provider = aws.dr

  name                = "${var.name_prefix}-synthetics-probe"
  description         = "Triggers the synthetic availability probe once a minute (region ${var.synthetics_dr_region})."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "synthetics_probe_dr" {
  count    = var.synthetics_enabled ? 1 : 0
  provider = aws.dr

  rule = aws_cloudwatch_event_rule.synthetics_probe_dr[0].name
  arn  = aws_lambda_function.synthetics_probe_dr[0].arn
}

resource "aws_lambda_permission" "synthetics_probe_dr" {
  count    = var.synthetics_enabled ? 1 : 0
  provider = aws.dr

  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.synthetics_probe_dr[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.synthetics_probe_dr[0].arn
}

# --- SLO dashboard ----------------------------------------------------------------------------
#
# A dedicated dashboard, separate from `aws_cloudwatch_dashboard.operations` in main.tf: that one
# answers "is our infrastructure healthy" (CPU, replica lag, memory); this one answers "is the
# user-facing availability SLO (NFR-03) being met", which is a different question with a different
# audience. Each check gets one widget (both regions' rolling success rate, plus the proposed SLO
# line via ANNOTATION_LINE — the same technique main.tf's realtime-probe widget already uses for
# its own SLO line), laid out in a 3-column grid, plus one combined latency widget.

locals {
  synthetics_widget_columns = 3
  synthetics_widget_width   = 24 / local.synthetics_widget_columns
  synthetics_widget_height  = 6

  # SyntheticCheckSuccess is 1/0 per minute; Average over a 1-hour period is that hour's rolling
  # success rate (0..1), and `100 * ` turns it into the percent the SLO is stated in.
  synthetic_check_widgets = [
    for index, check in local.synthetic_check_names : {
      type   = "metric"
      x      = (index % local.synthetics_widget_columns) * local.synthetics_widget_width
      y      = floor(index / local.synthetics_widget_columns) * local.synthetics_widget_height
      width  = local.synthetics_widget_width
      height = local.synthetics_widget_height
      properties = {
        title  = "${check} availability (SLO ${var.synthetics_availability_slo_percent}%)"
        region = var.aws_region
        stat   = "Average"
        period = 3600
        yAxis  = { left = { min = 0, max = 100 } }
        metrics = [
          [{ expression = "100 * m1", label = var.aws_region }],
          [
            var.synthetics_metric_namespace, "SyntheticCheckSuccess", "Check", check,
            { id = "m1", visible = false, stat = "Average", period = 3600, region = var.aws_region },
          ],
          [{ expression = "100 * m2", label = var.synthetics_dr_region }],
          [
            var.synthetics_metric_namespace, "SyntheticCheckSuccess", "Check", check,
            { id = "m2", visible = false, stat = "Average", period = 3600, region = var.synthetics_dr_region },
          ],
          # ANNOTATION_LINE paints the proposed SLO threshold as a solid reference line — see
          # main.tf's realtime-probe widget for the same technique and the same reason (the reader
          # should not need to know the number from the title alone).
          [{ expression = "ANNOTATION_LINE(${var.synthetics_availability_slo_percent}, 'SLO')", label = "SLO" }],
        ]
      }
    }
  ]

  synthetic_latency_widget = {
    type   = "metric"
    x      = 0
    y      = ceil(length(local.synthetic_check_names) / local.synthetics_widget_columns) * local.synthetics_widget_height
    width  = 24
    height = local.synthetics_widget_height
    properties = {
      title  = "Synthetic check latency (ms)"
      region = var.aws_region
      stat   = "Maximum"
      period = 60
      metrics = concat(
        [
          for check in local.synthetic_check_names : [
            var.synthetics_metric_namespace, "SyntheticCheckLatency", "Check", check,
            { label = "${check} (${var.aws_region})", region = var.aws_region },
          ]
        ],
        [
          for check in local.synthetic_check_names : [
            var.synthetics_metric_namespace, "SyntheticCheckLatency", "Check", check,
            { label = "${check} (${var.synthetics_dr_region})", region = var.synthetics_dr_region },
          ]
        ],
      )
    }
  }
}

resource "aws_cloudwatch_dashboard" "availability_slo" {
  count = var.synthetics_enabled ? 1 : 0

  dashboard_name = "${var.name_prefix}-availability-slo"
  dashboard_body = jsonencode({
    widgets = concat(local.synthetic_check_widgets, [local.synthetic_latency_widget])
  })
}
