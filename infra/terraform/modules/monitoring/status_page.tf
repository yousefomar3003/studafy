# --- Public status page sync (ST-264) ---------------------------------------------------------
#
# ## What this is
#
# A scheduled Lambda (lambda/status-page-sync/index.mjs), same EventBridge rate(1 minute) shape as
# the two probes above, that closes the loop ST-263 left open: a synthetic check failing already
# exists as a CloudWatch alarm (alerts.tf's synthetic_alarms/synthetic_alarms_dr, and the ST-149
# probe's own realtime-probe-latency-high), but nothing yet turns "an alarm is in ALARM state" into
# "the public status page says so". Every minute this Lambda reads the current state of the alarms
# mapped to each public component (DescribeAlarms — read-only, no state of its own) and PATCHes
# that component's status on the status-page provider account this repo does not own or provision
# (see "Why a third-party provider" below).
#
# ## Why polling, not the SNS alert bridge
#
# alerts.tf's alert_topic already fans every alarm state change out over SNS, and
# lambda/cloudwatch-alert-bridge already subscribes to it. Reacting to the same notifications here
# would need hand-rolled state aggregation: a component maps to more than one alarm (three checks
# speak for `api`, two probing regions speak for every synthetic check), and a stateless event
# handler receiving one alarm's OK notification cannot tell whether a *sibling* alarm for the same
# component is still firing without remembering something between invocations. Polling with
# DescribeAlarms sidesteps that entirely — every run recomputes every component's status from
# scratch, so a missed or out-of-order SNS delivery self-corrects on the very next run instead of
# leaving the public page wrong until someone notices. It also means this Lambda needs no new SNS
# subscription, no change to the shared alert-topic sub-module, and no state store of its own.
#
# ## Why a third-party provider, not a page this repo hosts and emails itself
#
# The acceptance criteria ask for subscriber emails and a manual incident-update workflow — a
# compliance surface (bounce/complaint handling, unsubscribe, CAN-SPAM headers) and an authoring UI
# this repo would otherwise have to build and operate from nothing. `docs/runbooks/on-call-
# rotation.md` already draws the identical boundary for paging: "the schedule, the escalation
# timers and the notification rules are configured behind those URLs" — this repo's job stops at
# feeding the signal in. This is that same boundary, applied to status communication instead of
# paging: this file owns the signal, the provider owns the page, the incident editor and subscriber
# delivery. `docs/runbooks/incident-comms-templates.md` is the human half — what to type into the
# provider's incident editor, and when.
#
# ## Component coverage, honestly
#
# Four of the five public components (api, web, billing, realtime) are backed by a real automatic
# signal — `local.status_page_component_alarms` below. The fifth, **ai**, is not: this repo has no
# synthetic probe against the Anthropic provider today
# (docs/runbooks/ai-provider-outage.md's own Detection section: "There is no CloudWatch alarm
# targeting Anthropic's availability today"). Rather than invent a signal to make five look like
# five, `ai` is deliberately absent from `local.status_page_component_alarms`, and
# lambda/status-page-sync never touches its status on the provider — it is set by hand, the same
# way an AI provider outage is triaged today. Closing this gap with a real probe is future work,
# not something this ticket pretends to have already done.

locals {
  # Component -> the synthetic-check names (synthetics.tf) that speak for it.
  status_page_synthetic_components = {
    web     = ["login-page"]
    api     = ["healthz", "oauth-start", "invitation-verify"]
    billing = ["checkout-page"]
  }

  # Each synthetic check becomes two alarms (alerts.tf: one per probing region) —
  # `aws_cloudwatch_metric_alarm.this["synthetic-<check>-failing"]` in var.aws_region,
  # `aws_cloudwatch_metric_alarm.synthetic_dr["synthetic-<check>-failing-dr"]` in
  # var.synthetics_dr_region. A component counts as degraded if *either* region's check is
  # failing, so both alarm names are collected here; index.mjs calls DescribeAlarms once per
  # region, not once per alarm. Alarm names are computed from the same "${name_prefix}-${key}"
  # convention aws_cloudwatch_metric_alarm.this/synthetic_dr use, rather than referencing those
  # resources directly, so this mapping stays valid even where synthetics_enabled is false and the
  # resources themselves have count 0 (the lists are simply empty then).
  status_page_component_alarms = merge(
    {
      for component, checks in local.status_page_synthetic_components : component => {
        primary = var.synthetics_enabled ? [for check in checks : "${var.name_prefix}-synthetic-${check}-failing"] : []
        dr      = var.synthetics_enabled ? [for check in checks : "${var.name_prefix}-synthetic-${check}-failing-dr"] : []
      }
    },
    {
      # realtime has no synthetic-check twin — it is spoken for by the ST-149 probe's own SLO alarm
      # (alerts.tf's probe_alarms), which exists in var.aws_region only: main.tf's realtime probe
      # has no aws.dr deployment, unlike the black-box checks above.
      realtime = {
        primary = var.probe_enabled ? ["${var.name_prefix}-realtime-probe-latency-high"] : []
        dr      = []
      }
    },
  )
}

data "archive_file" "status_page_sync" {
  type        = "zip"
  source_file = "${path.module}/lambda/status-page-sync/index.mjs"
  output_path = "${path.module}/lambda/status-page-sync/index.zip"
}

resource "aws_iam_role" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name        = "${var.name_prefix}-status-page-sync"
  description = "Runtime role for the status-page sync Lambda (ST-264): read-only against CloudWatch alarms, read-only against its one monitoring secret."
  # Reuses alerts.tf's shared lambda.amazonaws.com trust policy document rather than declaring a
  # fourth copy of the same statement (synthetics.tf and main.tf's realtime probe already reuse it
  # this same way).
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "status_page_sync_permissions" {
  statement {
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      for group in aws_cloudwatch_log_group.status_page_sync : "${group.arn}:*"
    ]
  }

  # cloudwatch:DescribeAlarms does not support resource-level permissions — AWS's own IAM action
  # reference lists only "*" for it (unlike PutMetricAlarm/SetAlarmState/DeleteAlarms, which do;
  # main.tf's ec2:CreateNetworkInterface/DescribeNetworkInterfaces/DeleteNetworkInterface grant for
  # the realtime probe is the same shape of constraint, undocumented there). The grant is read-only,
  # so an account-wide "*" here is a visibility grant, not a write capability.
  statement {
    effect    = "Allow"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }

  # The one secret this Lambda reads: STATUS_PAGE_API_KEY, STATUS_PAGE_PAGE_ID and one
  # STATUS_PAGE_COMPONENT_ID_<COMPONENT> per component it writes to — see this module's README for
  # the full key list and how to set them.
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.monitoring_secret_arn]
  }
}

resource "aws_iam_role_policy" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name   = "status-page-sync-permissions"
  role   = aws_iam_role.status_page_sync[0].id
  policy = data.aws_iam_policy_document.status_page_sync_permissions.json
}

resource "aws_cloudwatch_log_group" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-status-page-sync"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-status-page-sync"
  description      = "Public status page sync (ST-264): reads api/web/billing/realtime alarm state and pushes each component's status to the status-page provider. ai is deliberately excluded — see this file's header."
  role             = aws_iam_role.status_page_sync[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 20
  memory_size      = 128
  filename         = data.archive_file.status_page_sync.output_path
  source_code_hash = data.archive_file.status_page_sync.output_base64sha256

  environment {
    variables = {
      # AWS_REGION is Lambda-reserved (Terraform is refused if it tries to set it) — the function
      # reads its own deployment region from it directly, so only the *second* region needs an
      # explicit variable here. Empty wherever there are no dr-region alarms to read (synthetics
      # disabled), matching status_page_component_alarms's own dr lists being empty in that case.
      SYNTHETICS_DR_REGION  = var.synthetics_enabled ? var.synthetics_dr_region : ""
      MONITORING_SECRET_ARN = var.monitoring_secret_arn
      COMPONENT_ALARM_NAMES = jsonencode(local.status_page_component_alarms)
      TIMEOUT_MS            = "8000"
    }
  }
}

resource "aws_cloudwatch_event_rule" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name                = "${var.name_prefix}-status-page-sync"
  description         = "Triggers the status page sync once a minute."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  rule = aws_cloudwatch_event_rule.status_page_sync[0].name
  arn  = aws_lambda_function.status_page_sync[0].arn
}

resource "aws_lambda_permission" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.status_page_sync[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.status_page_sync[0].arn
}
