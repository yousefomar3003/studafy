# One CloudWatch alarm -> Alertmanager delivery path, in one region (ST-262).
#
# ## Why this is a module at all
#
# Because it has to exist twice. Almost every alarm this repo creates lives in `var.aws_region`
# (eu-central-1), but CloudFront only accepts ACM certificates issued in us-east-1 — a hard AWS
# constraint the root module already works around with an `aws.us_east_1` provider alias
# (`infra/terraform/providers.tf`). A CloudWatch alarm can only invoke an SNS topic in its *own*
# region, so watching that certificate's expiry means a second topic in us-east-1.
#
# Terraform cannot select a provider per `for_each` key, so "the same four resources, twice, under
# two providers" is a module instantiated twice — the idiomatic answer, and the one that keeps the
# key policy and the subscription from being copy-pasted and then drifting apart.
#
# The Lambda itself is *not* duplicated: SNS supports cross-region delivery to Lambda, so the
# us-east-1 topic subscribes the same eu-central-1 function, and there is exactly one place where
# an alarm is translated into an Alertmanager alert.

data "aws_caller_identity" "current" {}

# Encrypted with a customer-managed key rather than left unencrypted or set to the AWS-managed
# `alias/aws/sns`. Neither alternative works here:
#
# - Unencrypted fails this repo's own CI (trivy config scan, severity HIGH). `.trivyignore` is for
#   findings that pre-date the trivy pin, explicitly not for new resources — see its header.
# - `alias/aws/sns` is an AWS-managed key whose policy cannot be edited, so it grants nothing to
#   `cloudwatch.amazonaws.com`. A CloudWatch alarm publishing to a topic encrypted with it fails
#   with KMSAccessDenied — and fails *silently*, as a notification that never arrives, which is the
#   worst possible failure mode for the transport that carries pages.
resource "aws_kms_key" "this" {
  description             = "Encrypts ${var.name} CloudWatch alarm notifications in transit through SNS."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

data "aws_iam_policy_document" "key" {
  # Without this the key is unmanageable: a KMS key policy is the root of trust for the key, and a
  # key whose policy omits its own account can only be deleted by AWS support.
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

  # The whole reason for a customer-managed key. `GenerateDataKey*` is what SNS calls on the
  # publisher's behalf to envelope-encrypt the message; `Decrypt` is what it calls to read it back
  # before delivering to the Lambda subscription.
  statement {
    sid       = "CloudWatchAlarmPublish"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    # Scoped to this account, so the grant to a service principal cannot be exercised by that
    # service on behalf of anyone else — the confused-deputy guard AWS recommends for every
    # service-principal statement in a resource policy.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic" "this" {
  name              = var.name
  kms_master_key_id = aws_kms_key.this.id
}

# Only CloudWatch may publish. Without an explicit policy the topic is publishable by anything in
# the account holding `sns:Publish` — a page is exactly the kind of message worth being able to
# trust the provenance of.
data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "CloudWatchAlarmPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.this.arn]

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

resource "aws_sns_topic_policy" "this" {
  arn    = aws_sns_topic.this.arn
  policy = data.aws_iam_policy_document.topic.json
}

resource "aws_sns_topic_subscription" "bridge" {
  topic_arn = aws_sns_topic.this.arn
  protocol  = "lambda"
  endpoint  = var.bridge_function_arn
}

resource "aws_lambda_permission" "bridge" {
  # One statement id per topic, so the two instantiations of this module do not collide on the
  # single function's policy.
  statement_id  = "AllowSNS-${var.name}"
  action        = "lambda:InvokeFunction"
  function_name = var.bridge_function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.this.arn
}
