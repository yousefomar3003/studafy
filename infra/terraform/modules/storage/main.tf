# Two private S3 buckets: app-files (user-uploaded content, via pre-signed PUT/POST from
# apps/web) and backups-archive (operational backups, written by services/CI, never by a
# browser). Key-scheme and prefix conventions (schoolId placement, temp/reports categories):
# ../../../../docs/runbooks/storage-conventions.md.
#
# Both buckets get the same baseline hardening (public access block, BucketOwnerEnforced,
# versioning, SSE, deny-insecure-transport policy) via for_each — they are not two different
# security postures, just two different content types. CORS and the temp/reports lifecycle
# rules are app-files-only: backups-archive is never a browser upload target, and "archive"
# implies durable retention, not the ticket's 24h/7d expiry categories.

locals {
  buckets = {
    app_files       = "app-files"
    backups_archive = "backups-archive"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket        = "${var.name_prefix}-${each.value}"
  force_destroy = var.force_destroy
}

# BucketOwnerEnforced disables ACLs entirely, so "private" is enforced solely through the
# public access block below and the bucket policy — one mechanism to audit, not two.
resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 (AES256), not SSE-KMS: this project has no KMS key management set up yet (same
# "nothing to migrate from, nothing built to justify the extra piece yet" reasoning as the
# TLS-required decision in modules/redis/main.tf). Revisit if per-key access auditing or
# customer-managed keys become a real requirement.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Belt-and-suspenders alongside the public access block: even a future bucket policy change
# that accidentally grants public read cannot be reached over plaintext HTTP.
resource "aws_s3_bucket_policy" "deny_insecure_transport" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          each.value.arn,
          "${each.value.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
}

# Pre-signed uploads originate from apps/web in the browser, so only app-files needs a CORS
# policy — backups-archive is written by services/CI via the AWS SDK, which is not subject to
# browser CORS at all.
resource "aws_s3_bucket_cors_configuration" "app_files" {
  bucket = aws_s3_bucket.this["app_files"].id

  cors_rule {
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = [var.web_origin]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "app_files" {
  bucket = aws_s3_bucket.this["app_files"].id

  # AWS recommends lifecycle configuration depend explicitly on versioning being applied first,
  # so the noncurrent-version rule below is never evaluated against a not-yet-versioned bucket.
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "temp-expiration"
    status = "Enabled"

    filter {
      prefix = "temp/"
    }

    expiration {
      days = var.temp_expiration_days
    }
  }

  rule {
    id     = "reports-expiration"
    status = "Enabled"

    filter {
      prefix = "reports/"
    }

    expiration {
      days = var.reports_expiration_days
    }
  }

  rule {
    id     = "bucket-wide-cleanup"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups_archive" {
  bucket = aws_s3_bucket.this["backups_archive"].id

  depends_on = [aws_s3_bucket_versioning.this]

  # No temp/reports categories here on purpose — backups-archive holds durable backups, not
  # short-lived uploads. Only the noncurrent-version/multipart cleanup applies.
  rule {
    id     = "bucket-wide-cleanup"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }
}
