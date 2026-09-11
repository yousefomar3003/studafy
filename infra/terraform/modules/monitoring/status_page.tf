# --- Public status page (ST-264) ----------------------------------------------------------------
#
# ## What this is
#
# A self-hosted public status page: S3 (private, OAC) behind CloudFront, five Lambdas, and no
# third-party account to create by hand. `terraform apply` is the entire "go live" step.
#
# Two buckets, deliberately:
#
#   - `status_page_site`  — public, read through CloudFront: the static page itself
#     (status-page-site/index.html, styles.css, app.js) plus the two JSON documents it fetches
#     same-origin, `components.json` (written every minute by status-page-sync,
#     lambda/status-page-sync/index.mjs) and `incidents.json` (written by status-page-incident
#     whenever a human posts a manual update).
#   - `status_page_data`  — private, never granted to CloudFront, IAM-only: `subscribers.json`,
#     the one place a subscriber's email address is stored. A single OAC grant covering "the whole
#     bucket" would have made this PII publicly readable the moment it landed in the same bucket as
#     the page; two buckets makes that mistake structurally impossible rather than a policy to get
#     right by hand.
#
# ## Five Lambdas, one job each
#
#   - **status-page-sync** (already existed) — every minute, `DescribeAlarms`s the synthetic/probe
#     alarms mapped to each component and writes `components.json`. Automatic, no human involved —
#     this is what satisfies "synthetic failure reflects on page automatically".
#   - **status-page-incident** — the manual half: on-call POSTs a status/body (and, for a new
#     incident, a title/components/impact) to this Lambda's Function URL, authenticated with a
#     shared bearer token (`STATUS_PAGE_ADMIN_TOKEN`, in the existing `monitoring` app-secrets
#     container — the same access-control shape Grafana's admin password and Alertmanager's
#     receiver URLs already use there, chosen over AWS_IAM auth because this repo has no per-person
#     IAM principal for "on-call engineer" to grant `lambda:InvokeFunctionUrl` to). It updates
#     `incidents.json` and emails every confirmed subscriber.
#   - **status-page-subscribe** — the public "email me" form's backend. Double opt-in: it only ever
#     records an unconfirmed subscriber and sends a confirmation link.
#   - **status-page-subscription** — confirms or unsubscribes, from the link an email sent. One
#     Lambda for both: same shape of operation (find the subscriber, mutate one record).
#
# See each Lambda's own header for the rest of its reasoning (the S3 conditional-PutObject
# read-modify-write pattern shared by three of them, in particular).
#
# ## Why Lambda Function URLs, not API Gateway
#
# This repo has no API Gateway anywhere, and three simple HTTP entry points (one authenticated by a
# shared token, two public) are exactly what Function URLs exist to cover without it — no new AWS
# service, no REST/HTTP API resource to model, no stage/deployment lifecycle to manage for
# something this small.
#
# ## Why S3 JSON, not DynamoDB
#
# This repo has no DynamoDB table anywhere either, and every other piece of "small durable state" it
# owns lives in S3 (modules/storage) or Postgres (the tenant database, architecturally the wrong
# place for public, non-tenant-scoped subscriber data — see docs/runbooks/postgres-conventions.md).
# Incident posts and subscribe/confirm/unsubscribe are rare, human- or email-click-triggered events,
# not a high-concurrency write workload, so a single JSON object per concern with S3's own
# conditional PutObject (`If-Match` / `If-None-Match`) for correctness is proportionate — introducing
# a wholly new AWS service to this repo for this volume would not be.
#
# ## Component coverage
#
# `ai` now has a real automatic signal — the `ai-health` synthetic check (synthetics.tf, ST-264),
# which hits apps/api's `GET /api/ai/health` (apps/api/src/health.ts). That route deliberately does
# NOT call Anthropic (a real completion request once a minute, in every environment, would be a
# meaningful and pointless cost, and would answer "is the provider up" rather than "is this
# deployment's AI feature switched on") — it reports whether the `AI_LLM_ENABLED` kill switch is on,
# the same "is the route mounted and answering" contract `oauth-start` already has. A genuine
# Anthropic-provider outage is still detected and triaged the way
# docs/runbooks/ai-provider-outage.md already describes; this check's job is narrower — closing the
# gap where `ai` was the one public component nothing at all watched.
#
# ## Known gaps, stated plainly rather than left implicit
#
#   - **No custom domain.** The page is served at CloudFront's own `*.cloudfront.net` domain, not
#     `status.studafy.com` — adding one needs a DNS-validated ACM certificate in us-east-1 (the same
#     constraint module.cdn already works around with an `aws.us_east_1` provider alias) and a
#     Route 53 record, neither wired up here. The page is genuinely public HTTPS either way.
#   - **No rate limiting on the two public Function URLs** (subscribe, subscription). This repo has
#     no WAF wired to a Lambda Function URL today. Double opt-in bounds subscribe abuse to "someone
#     gets one unwanted confirmation email", not an actual subscription.
#   - **Subscriber emails only work where SES is actually provisioned** for this environment
#     (`var.ses_domain_identity_arn != null`, i.e. `dns_create_email_records = true` — prod today,
#     per infra/terraform/environments/*/*.tfvars). Where it isn't, the page and automatic component
#     sync still deploy and work; the incident/subscribe/subscription Lambdas simply aren't created
#     (see each resource's own `count` below) rather than existing half-broken.
#   - **`incidents.json` is capped at the most recent 25 incidents**, not a full archive. Proportionate
#     to what a status page needs to show; this repo does not mirror incident history anywhere else.

locals {
  # Component -> the synthetic-check names (synthetics.tf) that speak for it. `ai` is here on equal
  # footing with the other three now that ai-health exists — see this file's header.
  status_page_synthetic_components = {
    web     = ["login-page"]
    api     = ["healthz", "oauth-start", "invitation-verify"]
    billing = ["checkout-page"]
    ai      = ["ai-health"]
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

  status_page_email_enabled = var.status_page_enabled && var.ses_domain_identity_arn != null
}

# --- S3: the two buckets --------------------------------------------------------------------------
#
# Same baseline hardening as modules/storage's buckets (public access blocked, BucketOwnerEnforced,
# SSE-S3, deny-insecure-transport, versioned with noncurrent-version cleanup) — for_each over both
# rather than duplicating each resource twice, the same reasoning modules/storage's own header gives
# for its app_files/backups_archive pair: they are not two different security postures, just two
# different content types (one public-via-CDN, one never-granted-to-anything-but-its-own-Lambdas).

locals {
  status_page_buckets = var.status_page_enabled ? {
    site = "status-page-site"
    data = "status-page-data"
  } : {}
}

resource "aws_s3_bucket" "status_page" {
  for_each = local.status_page_buckets

  bucket        = "${var.name_prefix}-${each.value}"
  force_destroy = var.status_page_force_destroy_bucket

  tags = { Name = "${var.name_prefix}-${each.value}" }
}

resource "aws_s3_bucket_ownership_controls" "status_page" {
  for_each = aws_s3_bucket.status_page

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "status_page" {
  for_each = aws_s3_bucket.status_page

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "status_page" {
  for_each = aws_s3_bucket.status_page

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3, not SSE-KMS: this project has no KMS key management set up yet — same call modules/storage
# and modules/cdn's web_bundle bucket already make, for the same reason.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "status_page" {
  for_each = aws_s3_bucket.status_page

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# status_page["data"]'s only policy: deny-insecure-transport, nothing else — it is never granted to
# CloudFront (see this file's header). status_page["site"]'s policy is a second, separate resource
# below (aws_s3_bucket_policy.status_page_site) that combines this same statement with the
# CloudFront read grant into one document — S3 accepts exactly one policy per bucket, so a site
# bucket needing two statements gets one resource with two `statement` blocks, not two resources
# fighting over the same bucket (module.cdn's web_bundle policy is the same one-document-two-
# statements shape, in distribution.tf).
resource "aws_s3_bucket_policy" "status_page_data" {
  count = var.status_page_enabled ? 1 : 0

  bucket = aws_s3_bucket.status_page["data"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.status_page["data"].arn, "${aws_s3_bucket.status_page["data"].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

# 30 days: short deliberately, because status_page_data holds subscriber email addresses — an
# unsubscribe (readModifyWrite removing a record and writing the array back) still leaves the old
# version, containing that email, recoverable from version history until this expires it. The site
# bucket has no such PII concern but gets the identical lifecycle for one less thing to keep in sync.
resource "aws_s3_bucket_lifecycle_configuration" "status_page" {
  for_each = aws_s3_bucket.status_page

  bucket     = each.value.id
  depends_on = [aws_s3_bucket_versioning.status_page]

  rule {
    id     = "noncurrent-version-cleanup"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# --- CloudFront: fronts status_page["site"] only. status_page["data"] gets no OAC grant, no bucket
# policy beyond deny-insecure-transport above, and is reachable by nothing but the Lambdas' own IAM
# grants below — see this file's header for why that split exists at all.

resource "aws_cloudfront_origin_access_control" "status_page" {
  count = var.status_page_enabled ? 1 : 0

  name                              = "${var.name_prefix}-status-page"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# One cache policy for the whole distribution, TTL 0: every request is forwarded to the origin. No
# immutable/hashed-asset class to special-case (unlike module.cdn's web bundle) — this module has no
# build step to content-hash filenames, traffic is low, and always-fresh is worth more here than a
# cache-hit ratio target.
resource "aws_cloudfront_cache_policy" "status_page" {
  count = var.status_page_enabled ? 1 : 0

  name    = "${var.name_prefix}-status-page-no-cache"
  comment = "TTL 0 for the whole status page — every request forwarded to the origin."

  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "status_page" {
  count = var.status_page_enabled ? 1 : 0

  name = "${var.name_prefix}-status-page-no-cache"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-cache"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "status_page" {
  count = var.status_page_enabled ? 1 : 0

  comment             = "${var.name_prefix} public status page"
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  # No aliases/custom certificate — see this file's header's "No custom domain" known gap.
  price_class = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.status_page["site"].bucket_regional_domain_name
    origin_id                = aws_s3_bucket.status_page["site"].id
    origin_access_control_id = aws_cloudfront_origin_access_control.status_page[0].id
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = aws_s3_bucket.status_page["site"].id
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.status_page[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.status_page[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # No custom ACM certificate (see "No custom domain" above) — CloudFront's own default certificate
  # covers the *.cloudfront.net domain this distribution is reached at.
  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${var.name_prefix}-status-page" }
}

# One document, two statements — the CloudFront read grant and the same deny-insecure-transport
# statement status_page_data gets on its own, combined because this is the one bucket that needs
# both. Mirrors module.cdn's web_bundle policy (distribution.tf) exactly.
data "aws_iam_policy_document" "status_page_site" {
  count = var.status_page_enabled ? 1 : 0

  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.status_page["site"].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.status_page[0].arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.status_page["site"].arn, "${aws_s3_bucket.status_page["site"].arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "status_page_site" {
  count = var.status_page_enabled ? 1 : 0

  bucket = aws_s3_bucket.status_page["site"].id
  policy = data.aws_iam_policy_document.status_page_site[0].json
}

# --- Static site files -----------------------------------------------------------------------------

resource "aws_s3_object" "status_page_index_html" {
  count = var.status_page_enabled ? 1 : 0

  bucket       = aws_s3_bucket.status_page["site"].id
  key          = "index.html"
  source       = "${path.module}/status-page-site/index.html"
  etag         = filemd5("${path.module}/status-page-site/index.html")
  content_type = "text/html; charset=utf-8"
}

resource "aws_s3_object" "status_page_styles_css" {
  count = var.status_page_enabled ? 1 : 0

  bucket       = aws_s3_bucket.status_page["site"].id
  key          = "styles.css"
  source       = "${path.module}/status-page-site/styles.css"
  etag         = filemd5("${path.module}/status-page-site/styles.css")
  content_type = "text/css; charset=utf-8"
}

locals {
  # Empty wherever the subscribe Lambda doesn't exist (status_page_email_enabled false) — app.js's
  # own logic hides the subscribe section entirely when this templates to "".
  status_page_app_js = templatefile("${path.module}/status-page-site/app.js.tpl", {
    subscribe_url = local.status_page_email_enabled ? aws_lambda_function_url.status_page_subscribe[0].function_url : ""
  })
}

resource "aws_s3_object" "status_page_app_js" {
  count = var.status_page_enabled ? 1 : 0

  bucket       = aws_s3_bucket.status_page["site"].id
  key          = "app.js"
  content      = local.status_page_app_js
  etag         = md5(local.status_page_app_js)
  content_type = "application/javascript; charset=utf-8"
}

# --- status-page-sync (rewritten from the original PATCH-a-third-party design; see README's own
# note on this) ---------------------------------------------------------------------------------

data "archive_file" "status_page_sync" {
  type        = "zip"
  source_file = "${path.module}/lambda/status-page-sync/index.mjs"
  output_path = "${path.module}/lambda/status-page-sync/index.zip"
}

resource "aws_iam_role" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name               = "${var.name_prefix}-status-page-sync"
  description        = "Runtime role for the status-page sync Lambda (ST-264): read-only against CloudWatch alarms, write-only against its own bucket's components.json."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "status_page_sync_permissions" {
  count = var.status_page_enabled ? 1 : 0

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

  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.status_page["site"].arn}/components.json"]
  }
}

resource "aws_iam_role_policy" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name   = "status-page-sync-permissions"
  role   = aws_iam_role.status_page_sync[0].id
  policy = data.aws_iam_policy_document.status_page_sync_permissions[0].json
}

resource "aws_cloudwatch_log_group" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-status-page-sync"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "status_page_sync" {
  count = var.status_page_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-status-page-sync"
  description      = "Public status page sync (ST-264): reads api/web/billing/realtime/ai alarm state and writes components.json to the status page's own bucket."
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
      # explicit variable here.
      SYNTHETICS_DR_REGION  = var.synthetics_enabled ? var.synthetics_dr_region : ""
      BUCKET_NAME           = aws_s3_bucket.status_page["site"].id
      COMPONENT_ALARM_NAMES = jsonencode(local.status_page_component_alarms)
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

# --- status-page-incident ---------------------------------------------------------------------

data "archive_file" "status_page_incident" {
  type        = "zip"
  source_file = "${path.module}/lambda/status-page-incident/index.mjs"
  output_path = "${path.module}/lambda/status-page-incident/index.zip"
}

resource "aws_iam_role" "status_page_incident" {
  count = local.status_page_email_enabled ? 1 : 0

  name               = "${var.name_prefix}-status-page-incident"
  description        = "Runtime role for the manual-incident-update Lambda (ST-264)."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "status_page_incident_permissions" {
  count = local.status_page_email_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      for group in aws_cloudwatch_log_group.status_page_incident : "${group.arn}:*"
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.status_page["site"].arn}/incidents.json"]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.status_page["data"].arn}/subscribers.json"]
  }

  statement {
    effect    = "Allow"
    actions   = ["ses:SendEmail"]
    resources = [var.ses_domain_identity_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.monitoring_secret_arn]
  }
}

resource "aws_iam_role_policy" "status_page_incident" {
  count = local.status_page_email_enabled ? 1 : 0

  name   = "status-page-incident-permissions"
  role   = aws_iam_role.status_page_incident[0].id
  policy = data.aws_iam_policy_document.status_page_incident_permissions[0].json
}

resource "aws_cloudwatch_log_group" "status_page_incident" {
  count = local.status_page_email_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-status-page-incident"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "status_page_incident" {
  count = local.status_page_email_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-status-page-incident"
  description      = "Manual incident updates (ST-264): authenticated (STATUS_PAGE_ADMIN_TOKEN) write to incidents.json plus subscriber email fan-out."
  role             = aws_iam_role.status_page_incident[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 30
  memory_size      = 128
  filename         = data.archive_file.status_page_incident.output_path
  source_code_hash = data.archive_file.status_page_incident.output_base64sha256

  environment {
    variables = {
      SITE_BUCKET           = aws_s3_bucket.status_page["site"].id
      DATA_BUCKET           = aws_s3_bucket.status_page["data"].id
      MONITORING_SECRET_ARN = var.monitoring_secret_arn
      SES_FROM_ADDRESS      = var.status_page_from_address
      SUBSCRIPTION_URL      = aws_lambda_function_url.status_page_subscription[0].function_url
    }
  }
}

resource "aws_lambda_function_url" "status_page_incident" {
  count = local.status_page_email_enabled ? 1 : 0

  function_name      = aws_lambda_function.status_page_incident[0].function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "status_page_incident_url" {
  count = local.status_page_email_enabled ? 1 : 0

  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.status_page_incident[0].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# --- status-page-subscribe --------------------------------------------------------------------

data "archive_file" "status_page_subscribe" {
  type        = "zip"
  source_file = "${path.module}/lambda/status-page-subscribe/index.mjs"
  output_path = "${path.module}/lambda/status-page-subscribe/index.zip"
}

resource "aws_iam_role" "status_page_subscribe" {
  count = local.status_page_email_enabled ? 1 : 0

  name               = "${var.name_prefix}-status-page-subscribe"
  description        = "Runtime role for the public subscribe Lambda (ST-264)."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "status_page_subscribe_permissions" {
  count = local.status_page_email_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      for group in aws_cloudwatch_log_group.status_page_subscribe : "${group.arn}:*"
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.status_page["data"].arn}/subscribers.json"]
  }

  statement {
    effect    = "Allow"
    actions   = ["ses:SendEmail"]
    resources = [var.ses_domain_identity_arn]
  }
}

resource "aws_iam_role_policy" "status_page_subscribe" {
  count = local.status_page_email_enabled ? 1 : 0

  name   = "status-page-subscribe-permissions"
  role   = aws_iam_role.status_page_subscribe[0].id
  policy = data.aws_iam_policy_document.status_page_subscribe_permissions[0].json
}

resource "aws_cloudwatch_log_group" "status_page_subscribe" {
  count = local.status_page_email_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-status-page-subscribe"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "status_page_subscribe" {
  count = local.status_page_email_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-status-page-subscribe"
  description      = "Public subscribe endpoint (ST-264): double opt-in — records an unconfirmed subscriber and emails a confirmation link."
  role             = aws_iam_role.status_page_subscribe[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 20
  memory_size      = 128
  filename         = data.archive_file.status_page_subscribe.output_path
  source_code_hash = data.archive_file.status_page_subscribe.output_base64sha256

  environment {
    variables = {
      DATA_BUCKET      = aws_s3_bucket.status_page["data"].id
      SES_FROM_ADDRESS = var.status_page_from_address
      CONFIRM_BASE_URL = aws_lambda_function_url.status_page_subscription[0].function_url
      STATUS_PAGE_URL  = "https://${aws_cloudfront_distribution.status_page[0].domain_name}"
    }
  }
}

resource "aws_lambda_function_url" "status_page_subscribe" {
  count = local.status_page_email_enabled ? 1 : 0

  function_name      = aws_lambda_function.status_page_subscribe[0].function_name
  authorization_type = "NONE"

  # The public page's own fetch() call is the only intended caller — scoped to the CloudFront
  # domain it's served from rather than "*".
  cors {
    allow_origins = ["https://${aws_cloudfront_distribution.status_page[0].domain_name}"]
    allow_methods = ["POST"]
    allow_headers = ["content-type"]
    max_age       = 300
  }
}

resource "aws_lambda_permission" "status_page_subscribe_url" {
  count = local.status_page_email_enabled ? 1 : 0

  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.status_page_subscribe[0].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# --- status-page-subscription (confirm / unsubscribe) ---------------------------------------------

data "archive_file" "status_page_subscription" {
  type        = "zip"
  source_file = "${path.module}/lambda/status-page-subscription/index.mjs"
  output_path = "${path.module}/lambda/status-page-subscription/index.zip"
}

resource "aws_iam_role" "status_page_subscription" {
  count = local.status_page_email_enabled ? 1 : 0

  name               = "${var.name_prefix}-status-page-subscription"
  description        = "Runtime role for the confirm/unsubscribe Lambda (ST-264)."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "status_page_subscription_permissions" {
  count = local.status_page_email_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      for group in aws_cloudwatch_log_group.status_page_subscription : "${group.arn}:*"
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.status_page["data"].arn}/subscribers.json"]
  }
}

resource "aws_iam_role_policy" "status_page_subscription" {
  count = local.status_page_email_enabled ? 1 : 0

  name   = "status-page-subscription-permissions"
  role   = aws_iam_role.status_page_subscription[0].id
  policy = data.aws_iam_policy_document.status_page_subscription_permissions[0].json
}

resource "aws_cloudwatch_log_group" "status_page_subscription" {
  count = local.status_page_email_enabled ? 1 : 0

  name              = "/aws/lambda/${var.name_prefix}-status-page-subscription"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "status_page_subscription" {
  count = local.status_page_email_enabled ? 1 : 0

  function_name    = "${var.name_prefix}-status-page-subscription"
  description      = "Confirm / unsubscribe (ST-264): the two email-link flows for the status page's subscriber list."
  role             = aws_iam_role.status_page_subscription[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 20
  memory_size      = 128
  filename         = data.archive_file.status_page_subscription.output_path
  source_code_hash = data.archive_file.status_page_subscription.output_base64sha256

  environment {
    variables = {
      DATA_BUCKET = aws_s3_bucket.status_page["data"].id
    }
  }
}

resource "aws_lambda_function_url" "status_page_subscription" {
  count = local.status_page_email_enabled ? 1 : 0

  function_name      = aws_lambda_function.status_page_subscription[0].function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "status_page_subscription_url" {
  count = local.status_page_email_enabled ? 1 : 0

  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.status_page_subscription[0].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
