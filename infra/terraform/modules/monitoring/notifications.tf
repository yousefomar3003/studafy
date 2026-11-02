# --- Alert delivery through AWS SNS ---------------------------------------------------------------
#
# Where Alertmanager's three receivers actually deliver. Each one is an SNS topic in this account
# rather than a third-party on-call provider's webhook, so every hop from "something is wrong" to
# "an email or SMS arrives" stays inside AWS:
#
#   page      critical alerts -> email + SMS (var.alert_email_addresses, var.alert_sms_numbers)
#   ticket    warning alerts  -> email only
#   heartbeat the Watchdog    -> no subscribers; watched by the alarm at the bottom of this file
#
# Not to be confused with alerts.tf's `module.alert_topic`, which carries CloudWatch alarm *state
# changes* to the bridge Lambda and on into Alertmanager. These topics are the far end of that
# path: Alertmanager has already routed, grouped and deduplicated by the time it publishes here.
#
# SNS has no acknowledge button, no rotation and no escalation timers — what
# docs/runbooks/on-call-rotation.md describes as the provider's job is, with this transport, a
# matter of who is subscribed and of reading the email. That is the accepted trade for keeping
# alerting AWS-only.

locals {
  # `name` is the topic-name suffix, appended to `name_prefix`.
  alert_delivery_topics = var.monitoring_enabled ? {
    page      = "${var.name_prefix}-alerts-page"
    ticket    = "${var.name_prefix}-alerts-ticket"
    heartbeat = "${var.name_prefix}-alerts-heartbeat"
  } : {}

  # Email goes to both human-facing topics; SMS only to page, so a warning never texts anyone.
  alert_subscriptions = merge(
    { for email in var.alert_email_addresses : "page-email-${email}" => { topic = "page", protocol = "email", endpoint = email } },
    { for email in var.alert_email_addresses : "ticket-email-${email}" => { topic = "ticket", protocol = "email", endpoint = email } },
    { for number in var.alert_sms_numbers : "page-sms-${number}" => { topic = "page", protocol = "sms", endpoint = number } },
  )
}

data "aws_caller_identity" "current" {}

# One customer-managed key for all three topics, for the same reason modules/alert-topic has its
# own: unencrypted topics fail trivy, and the AWS-managed alias/aws/sns key cannot grant
# cloudwatch.amazonaws.com the access the heartbeat alarm needs to publish to the page topic.
resource "aws_kms_key" "alert_delivery" {
  count = var.monitoring_enabled ? 1 : 0

  description             = "Encrypts ${var.name_prefix} alert notifications (page/ticket/heartbeat SNS topics)."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.alert_delivery_key.json
}

resource "aws_kms_alias" "alert_delivery" {
  count = var.monitoring_enabled ? 1 : 0

  name          = "alias/${var.name_prefix}-alerts-delivery"
  target_key_id = aws_kms_key.alert_delivery[0].key_id
}

data "aws_iam_policy_document" "alert_delivery_key" {
  # Account administration, and what lets the Alertmanager task role's own IAM grant
  # (alertmanager.tf) take effect — a KMS key only honours IAM policies its key policy delegates to.
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # The heartbeat alarm below publishes to the page topic.
  statement {
    sid       = "CloudWatchAlarmPublish"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic" "alert_delivery" {
  for_each = local.alert_delivery_topics

  name              = each.value
  kms_master_key_id = aws_kms_key.alert_delivery[0].id

  lifecycle {
    precondition {
      condition     = length(var.alert_email_addresses) > 0
      error_message = "alert_email_addresses is empty: with monitoring enabled, every page and ticket would be published to a topic nobody is subscribed to."
    }
  }
}

# Only Alertmanager may publish, plus CloudWatch on the page topic for the heartbeat alarm.
data "aws_iam_policy_document" "alert_delivery_topic" {
  for_each = local.alert_delivery_topics

  statement {
    sid       = "AlertmanagerPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alert_delivery[each.key].arn]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.alertmanager_task[0].arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "page" ? [1] : []

    content {
      sid       = "CloudWatchAlarmPublish"
      effect    = "Allow"
      actions   = ["sns:Publish"]
      resources = [aws_sns_topic.alert_delivery[each.key].arn]

      principals {
        type        = "Service"
        identifiers = ["cloudwatch.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }
    }
  }
}

resource "aws_sns_topic_policy" "alert_delivery" {
  for_each = local.alert_delivery_topics

  arn    = aws_sns_topic.alert_delivery[each.key].arn
  policy = data.aws_iam_policy_document.alert_delivery_topic[each.key].json
}

# Email subscriptions stay "pending confirmation" until the recipient clicks the link AWS sends —
# nothing is delivered to an unconfirmed address. Terraform cannot confirm them on anyone's behalf.
resource "aws_sns_topic_subscription" "alert_delivery" {
  for_each = var.monitoring_enabled ? local.alert_subscriptions : {}

  topic_arn = aws_sns_topic.alert_delivery[each.value.topic].arn
  protocol  = each.value.protocol
  endpoint  = each.value.endpoint
}

# --- The heartbeat --------------------------------------------------------------------------------
#
# Alertmanager publishes the always-firing Watchdog alert to the heartbeat topic every 5 minutes
# (infra/docker/alertmanager/alertmanager.yml). SNS counts those publishes; this alarm pages when
# the count drops to zero for 15 minutes — Prometheus not evaluating, Alertmanager down, or its SNS
# publishing broken. `treat_missing_data = "breaching"` is the point: no publishes means no data.
#
# It notifies the page topic *directly*, not through alerts.tf's bridge, because the bridge
# delivers into Alertmanager — the very thing this alarm exists to catch being down. It is also why
# this alarm is not in alerts.tf's catalog. Its runbook is alert-catalog.md's Watchdog section.
#
# Expect it in ALARM briefly on the first apply, until Alertmanager's first heartbeat lands.
resource "aws_cloudwatch_metric_alarm" "alertmanager_heartbeat" {
  count = var.monitoring_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-alertmanager-heartbeat-missing"
  alarm_description   = "No Watchdog heartbeat from Alertmanager for 15 minutes: alerting is down, assume no other alert can reach you. See docs/runbooks/alert-catalog.md#watchdog."
  namespace           = "AWS/SNS"
  metric_name         = "NumberOfMessagesPublished"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { TopicName = aws_sns_topic.alert_delivery["heartbeat"].name }

  alarm_actions = [aws_sns_topic.alert_delivery["page"].arn]
  ok_actions    = [aws_sns_topic.alert_delivery["page"].arn]
}
