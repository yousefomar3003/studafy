# --- Ingest path: CloudWatch Logs -> Firehose -> S3 -----------------------------------------
#
# A CloudWatch Logs subscription filter has exactly three possible destinations (Kinesis Data
# Streams, Firehose, Lambda) — never S3 directly — so Firehose is the required hop out of
# CloudWatch. Two delivery streams, because there are two destinations with two retention regimes:
#
#   logs   (main)      -> archive bucket. Fed by every subscribed group. Vector reads this bucket
#                         (via S3 -> SQS) and ships to Loki; the bucket is also the cold tier.
#   logs-security      -> security (Object Lock) bucket, write-once. Fed only by the groups in
#                         var.security_log_group_names. This is the "mirrored write-once" half:
#                         those groups are subscribed to *both* streams, so a security line lands
#                         in Loki (via main) and immutably in S3 (via this one) with no Vector in
#                         the write-once path at all — the immutability guarantee doesn't depend on
#                         a collector staying healthy.
#
# Firehose does the CloudWatch envelope handling itself, so Vector never has to fan out a
# logEvents[] array (which Vector has no first-class transform for). Three built-in processors, in
# order: Decompression unwraps the per-record gzip a subscription applies; CloudWatchLogProcessing
# (DataMessageExtraction) drops CONTROL_MESSAGE keepalives and emits one record per logEvents[]
# entry — just the `message` string, which for app traffic is the NDJSON line SAD §28 defines;
# AppendDelimiterToRecord puts a newline between records so the delivered object is
# newline-delimited and both Vector and Athena can split it.

data "aws_caller_identity" "current" {}

locals {
  security_log_groups = toset(var.security_log_group_names)
  # Every subscribed group feeds the main stream; security groups additionally feed the security
  # stream. A set keyed by name keeps both for_each maps stable if the input lists overlap.
  main_subscription_log_groups = toset(concat(var.app_log_group_names, var.security_log_group_names))
}

# --- SQS: the archive-bucket notification queue Vector drains -------------------------------

resource "aws_sqs_queue" "ingest_dlq" {
  name                      = "${var.name_prefix}-logs-ingest-dlq"
  message_retention_seconds = 1209600 # 14 days — the max, so a poison object can be inspected
  sqs_managed_sse_enabled   = true

  tags = { Name = "${var.name_prefix}-logs-ingest-dlq" }
}

resource "aws_sqs_queue" "ingest" {
  name                       = "${var.name_prefix}-logs-ingest"
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 345600 # 4 days
  visibility_timeout_seconds = 300    # matches Vector's aws_s3 source default; long enough for one object

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    maxReceiveCount     = var.sqs_max_receive_count
  })

  tags = { Name = "${var.name_prefix}-logs-ingest" }
}

data "aws_iam_policy_document" "ingest_queue" {
  statement {
    sid    = "AllowArchiveBucketNotifications"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ingest.arn]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.this["archive"].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "ingest" {
  queue_url = aws_sqs_queue.ingest.id
  policy    = data.aws_iam_policy_document.ingest_queue.json
}

# --- Firehose: shared plumbing -----------------------------------------------------------

resource "aws_cloudwatch_log_group" "firehose" {
  name              = "/${var.name_prefix}/firehose/logs"
  retention_in_days = var.plane_log_retention_days
}

resource "aws_cloudwatch_log_stream" "firehose_main" {
  name           = "main-delivery"
  log_group_name = aws_cloudwatch_log_group.firehose.name
}

resource "aws_cloudwatch_log_stream" "firehose_security" {
  name           = "security-delivery"
  log_group_name = aws_cloudwatch_log_group.firehose.name
}

data "aws_iam_policy_document" "firehose_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

# One delivery role per destination bucket, not one shared role: the whole point of the security
# bucket is that exactly one principal can write it. A shared role would also let the main stream
# write the WORM bucket.
resource "aws_iam_role" "firehose_main" {
  name               = "${var.name_prefix}-logs-firehose-main"
  description        = "Delivery role for the main log Firehose: writes the archive bucket only."
  assume_role_policy = data.aws_iam_policy_document.firehose_assume_role.json
}

resource "aws_iam_role" "firehose_security" {
  name               = "${var.name_prefix}-logs-firehose-security"
  description        = "Delivery role for the security log Firehose: writes the write-once security bucket only."
  assume_role_policy = data.aws_iam_policy_document.firehose_assume_role.json
}

data "aws_iam_policy_document" "firehose_main" {
  statement {
    sid    = "WriteArchiveBucket"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.this["archive"].arn,
      "${aws_s3_bucket.this["archive"].arn}/*",
    ]
  }

  statement {
    sid       = "WriteOwnDeliveryLog"
    effect    = "Allow"
    actions   = ["logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.firehose.arn}:*"]
  }
}

# No s3:DeleteObject / s3:PutObjectRetention: the security delivery role can create an immutable
# object and nothing more. S3 applies the bucket's COMPLIANCE-mode default retention on write.
data "aws_iam_policy_document" "firehose_security" {
  statement {
    sid    = "WriteSecurityBucket"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.this["security"].arn,
      "${aws_s3_bucket.this["security"].arn}/*",
    ]
  }

  statement {
    sid       = "WriteOwnDeliveryLog"
    effect    = "Allow"
    actions   = ["logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.firehose.arn}:*"]
  }
}

resource "aws_iam_role_policy" "firehose_main" {
  name   = "delivery"
  role   = aws_iam_role.firehose_main.id
  policy = data.aws_iam_policy_document.firehose_main.json
}

resource "aws_iam_role_policy" "firehose_security" {
  name   = "delivery"
  role   = aws_iam_role.firehose_security.id
  policy = data.aws_iam_policy_document.firehose_security.json
}

# --- Firehose: main stream -> archive bucket -------------------------------------------

resource "aws_kinesis_firehose_delivery_stream" "logs" {
  name        = "${var.name_prefix}-logs"
  destination = "extended_s3"

  server_side_encryption {
    enabled = true # AWS-owned key; the archive bucket's own SSE-S3 covers the objects at rest
  }

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose_main.arn
    bucket_arn = aws_s3_bucket.this["archive"].arn

    # Date-partitioned so a cold restore (Athena, or a targeted re-ingest) can scope by day
    # without listing the whole bucket. Service is a Loki label, not a prefix.
    prefix              = "logs/date=!{timestamp:yyyy/MM/dd}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/date=!{timestamp:yyyy/MM/dd}/"

    buffering_interval = var.firehose_buffer_seconds
    buffering_size     = var.firehose_buffer_mib
    compression_format = "GZIP"

    # Order matters and is the array order below: unwrap the subscription's per-record gzip, then
    # drop CONTROL_MESSAGE keepalives and emit one record per logEvents[] entry, then newline-
    # delimit the delivered object. AWS's documented form for the delimiter is the literal
    # two-character string backslash-n.
    processing_configuration {
      enabled = true

      processors {
        type = "Decompression"
        parameters {
          parameter_name  = "CompressionFormat"
          parameter_value = "GZIP"
        }
      }

      processors {
        type = "CloudWatchLogProcessing"
        parameters {
          parameter_name  = "DataMessageExtraction"
          parameter_value = "true"
        }
      }

      processors {
        type = "AppendDelimiterToRecord"
        parameters {
          parameter_name  = "Delimiter"
          parameter_value = "\\n"
        }
      }
    }

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = aws_cloudwatch_log_stream.firehose_main.name
    }
  }

  tags = { Name = "${var.name_prefix}-logs" }
}

# --- Firehose: security stream -> write-once bucket -----------------------------------
#
# Always created, even where var.security_log_group_names is empty and nothing is subscribed to
# it: an idle delivery stream has no standing cost, and creating it unconditionally keeps this
# file free of count/[0] plumbing.

resource "aws_kinesis_firehose_delivery_stream" "security" {
  name        = "${var.name_prefix}-logs-security"
  destination = "extended_s3"

  server_side_encryption {
    enabled = true
  }

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose_security.arn
    bucket_arn = aws_s3_bucket.this["security"].arn

    prefix              = "stream/date=!{timestamp:yyyy/MM/dd}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/date=!{timestamp:yyyy/MM/dd}/"

    # Flush hard (60s / 1 MiB): the security mirror favours getting each line committed to the
    # immutable store quickly over batching efficiency.
    buffering_interval = 60
    buffering_size     = 1
    compression_format = "GZIP"

    processing_configuration {
      enabled = true

      processors {
        type = "Decompression"
        parameters {
          parameter_name  = "CompressionFormat"
          parameter_value = "GZIP"
        }
      }

      processors {
        type = "CloudWatchLogProcessing"
        parameters {
          parameter_name  = "DataMessageExtraction"
          parameter_value = "true"
        }
      }

      processors {
        type = "AppendDelimiterToRecord"
        parameters {
          parameter_name  = "Delimiter"
          parameter_value = "\\n"
        }
      }
    }

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = aws_cloudwatch_log_stream.firehose_security.name
    }
  }

  tags = { Name = "${var.name_prefix}-logs-security" }
}

# --- archive -> SQS notification ---------------------------------------------------------

# Every object the main Firehose writes under logs/ raises a message on the ingest queue; Vector's
# aws_s3 source consumes the queue and reads the object. errors/ (Firehose's own failed-delivery
# dump) is excluded — those are diagnostics, not application logs to ship onward.
resource "aws_s3_bucket_notification" "archive" {
  bucket = aws_s3_bucket.this["archive"].id

  queue {
    queue_arn     = aws_sqs_queue.ingest.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "logs/"
  }

  depends_on = [aws_sqs_queue_policy.ingest]
}

# --- CloudWatch Logs subscription filters --------------------------------------------

data "aws_iam_policy_document" "cwl_to_firehose_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "cwl_to_firehose" {
  name               = "${var.name_prefix}-logs-cwl-to-firehose"
  description        = "Assumed by CloudWatch Logs to forward the subscribed groups into the main and security Firehoses."
  assume_role_policy = data.aws_iam_policy_document.cwl_to_firehose_assume_role.json
}

data "aws_iam_policy_document" "cwl_to_firehose" {
  statement {
    effect  = "Allow"
    actions = ["firehose:PutRecord", "firehose:PutRecordBatch"]
    resources = [
      aws_kinesis_firehose_delivery_stream.logs.arn,
      aws_kinesis_firehose_delivery_stream.security.arn,
    ]
  }
}

resource "aws_iam_role_policy" "cwl_to_firehose" {
  name   = "put-records"
  role   = aws_iam_role.cwl_to_firehose.id
  policy = data.aws_iam_policy_document.cwl_to_firehose.json
}

# Every subscribed group -> main stream.
resource "aws_cloudwatch_log_subscription_filter" "to_main" {
  for_each = local.main_subscription_log_groups

  name            = "${var.name_prefix}-logs-to-firehose"
  log_group_name  = each.value
  filter_pattern  = "" # every line
  destination_arn = aws_kinesis_firehose_delivery_stream.logs.arn
  role_arn        = aws_iam_role.cwl_to_firehose.arn
  distribution    = "ByLogStream"
}

# Security groups additionally -> security stream. A CloudWatch Logs group allows up to two
# subscription filters, so a security group ends up with exactly two: one here, one above.
resource "aws_cloudwatch_log_subscription_filter" "to_security" {
  for_each = local.security_log_groups

  name            = "${var.name_prefix}-logs-to-firehose-security"
  log_group_name  = each.value
  filter_pattern  = ""
  destination_arn = aws_kinesis_firehose_delivery_stream.security.arn
  role_arn        = aws_iam_role.cwl_to_firehose.arn
  distribution    = "ByLogStream"
}
