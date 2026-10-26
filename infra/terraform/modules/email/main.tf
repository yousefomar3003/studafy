# Transactional email delivery plumbing around the SES domain identity that modules/dns verifies:
#
# - a configuration set apps/workers sends through (SES_CONFIGURATION_SET), whose BOUNCE and
#   COMPLAINT events are published to an SNS topic;
# - that topic's HTTPS subscription to the API's /email/webhooks/sns (apps/api/src/email/webhook.ts),
#   which verifies each message's signature against EMAIL_EVENTS_SNS_TOPIC_ARN, confirms the
#   subscription itself, and suppresses the address so the dispatcher never mails it again;
# - the workers task role's permission to send, scoped to exactly this identity and configuration set.
#
# Everything is created only where a sending domain is (var.enabled = dns_create_email_records, prod
# today). Elsewhere the workers run with EMAIL_DRY_RUN=true.

data "aws_caller_identity" "current" {}

resource "aws_sesv2_configuration_set" "transactional" {
  count                  = var.enabled ? 1 : 0
  configuration_set_name = "${var.name_prefix}-transactional"

  reputation_options {
    reputation_metrics_enabled = true
  }

  # SES's own account-level suppression list as a backstop to the API's suppression table.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

# Customer-managed, not `alias/aws/sns`: that AWS-managed key's policy cannot be edited, so it grants
# nothing to `ses.amazonaws.com` and SES refuses to create the event destination (same constraint as
# modules/monitoring/modules/alert-topic's key, there for CloudWatch).
resource "aws_kms_key" "email_events" {
  count                   = var.enabled ? 1 : 0
  description             = "Encrypts ${var.name_prefix} SES bounce/complaint events in transit through SNS."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.email_events_key[0].json
}

resource "aws_kms_alias" "email_events" {
  count         = var.enabled ? 1 : 0
  name          = "alias/${var.name_prefix}-email-events"
  target_key_id = aws_kms_key.email_events[0].key_id
}

data "aws_iam_policy_document" "email_events_key" {
  count = var.enabled ? 1 : 0

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

  statement {
    sid       = "SesPublish"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic" "email_events" {
  count             = var.enabled ? 1 : 0
  name              = "${var.name_prefix}-email-events"
  kms_master_key_id = aws_kms_key.email_events[0].id
}

# SES publishes as the service principal; the source-account condition stops another account's SES
# from publishing into this topic.
data "aws_iam_policy_document" "email_events_publish" {
  count = var.enabled ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.email_events[0].arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "email_events" {
  count  = var.enabled ? 1 : 0
  arn    = aws_sns_topic.email_events[0].arn
  policy = data.aws_iam_policy_document.email_events_publish[0].json
}

resource "aws_sesv2_configuration_set_event_destination" "bounces_and_complaints" {
  count                  = var.enabled ? 1 : 0
  configuration_set_name = aws_sesv2_configuration_set.transactional[0].configuration_set_name
  event_destination_name = "bounces-and-complaints"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.email_events[0].arn
    }
  }

  depends_on = [aws_sns_topic_policy.email_events]
}

# The API answers the SubscriptionConfirmation itself by fetching the signed SubscribeURL, so the
# subscription confirms on the API's first deploy; until then SNS retries the confirmation.
resource "aws_sns_topic_subscription" "api_webhook" {
  count                  = var.enabled ? 1 : 0
  topic_arn              = aws_sns_topic.email_events[0].arn
  protocol               = "https"
  endpoint               = var.webhook_url
  endpoint_auto_confirms = true
}

data "aws_iam_policy_document" "workers_send" {
  count = var.enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    # SESv2 SendEmail is authorised against both the identity and the configuration set it uses.
    resources = [
      var.ses_identity_arn,
      aws_sesv2_configuration_set.transactional[0].arn,
    ]

    # Only as the verified sending domain: a leaked task credential cannot send as another identity.
    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*@${var.ses_domain}"]
    }
  }
}

resource "aws_iam_role_policy" "workers_send" {
  count  = var.enabled ? 1 : 0
  name   = "${var.name_prefix}-workers-ses-send"
  role   = var.workers_task_role_id
  policy = data.aws_iam_policy_document.workers_send[0].json
}
