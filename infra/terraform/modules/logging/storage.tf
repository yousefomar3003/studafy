# --- Object storage for the pipeline ---------------------------------------------------------
#
# Three buckets, one job each:
#
#   loki-chunks    Loki's own object store (chunks + TSDB index). Lifetime is governed by Loki's
#                  compactor (var.loki_retention), not by S3 — the lifecycle rule here only sweeps
#                  the debris every store leaves behind (aborted multipart uploads, noncurrent
#                  versions). This is the HOT, queryable copy.
#   logs-archive   Every line Firehose delivers, gzipped, date-partitioned. This is the COLD copy:
#                  transitioned to Glacier Instant Retrieval at var.archive_transition_days and
#                  deleted at var.archive_expiration_days (~13 months). Not live-queryable — a
#                  restore means Athena over the objects or re-ingesting them.
#   logs-security  The security stream's write-once mirror. Object Lock in COMPLIANCE mode with a
#                  default retention of var.security_lock_retention_days: nothing, including the
#                  root account and a `terraform destroy`, can delete or overwrite an object
#                  before that elapses.
#
# The baseline hardening (public access block, BucketOwnerEnforced, versioning, SSE-S3,
# deny-insecure-transport) is identical across all three and applied by for_each, exactly as
# modules/storage does it — they are three content types, not three security postures. Only the
# security bucket additionally carries `object_lock_enabled = true`, which S3 requires to be set
# at bucket creation and can never be added afterward.

locals {
  buckets = {
    chunks   = "${var.name_prefix}-loki-chunks"
    archive  = "${var.name_prefix}-logs-archive"
    security = "${var.name_prefix}-logs-security"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket = each.value

  # Only the security bucket is a WORM store. Enabling Object Lock on the other two would buy
  # nothing and make routine lifecycle expiration fight a retention lock.
  object_lock_enabled = each.key == "security"
}

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
    # Object Lock requires versioning on the security bucket; the other two match modules/storage's
    # own "versioning on every bucket, noncurrent cleanup in the lifecycle rule" convention.
    status = "Enabled"
  }
}

# SSE-S3 (AES256), not SSE-KMS: consistent with modules/storage — this project has no KMS key
# management set up for data-plane encryption yet. Revisit alongside modules/storage's AWS-0132
# waiver (.trivyignore) if customer-managed keys become a requirement.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Belt-and-suspenders alongside the public access block: no object in any of these buckets is ever
# reachable over plaintext HTTP, even if a future policy change slips.
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
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  })
}

# --- loki-chunks: cleanup only ---------------------------------------------------------------

resource "aws_s3_bucket_lifecycle_configuration" "chunks" {
  bucket = aws_s3_bucket.this["chunks"].id

  # Versioning is on (baseline above), so this rule is what stops every compacted-away index file
  # from accumulating as a noncurrent version forever.
  rule {
    id     = "sweep-debris"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# --- logs-archive: the cold tier -----------------------------------------------------------

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.this["archive"].id

  rule {
    id     = "hot-to-cold-to-gone"
    status = "Enabled"

    filter {}

    transition {
      days          = var.archive_transition_days
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = var.archive_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# --- logs-security: write-once ------------------------------------------------------------

# COMPLIANCE, not GOVERNANCE: GOVERNANCE mode lets a principal holding
# s3:BypassGovernanceRetention delete early, which defeats the point of an audit mirror. COMPLIANCE
# has no bypass — the retention is absolute until it expires. The trade-off is real and stated in
# the README: a mistaken write is also permanent for `security_lock_retention_days`.
resource "aws_s3_bucket_object_lock_configuration" "security" {
  bucket = aws_s3_bucket.this["security"].id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.security_lock_retention_days
    }
  }
}

# The security bucket expires objects on the same ~13-month horizon as the cold archive. S3 only
# honours this once an object's Object-Lock retention has elapsed, so expiration and the lock stay
# consistent by construction rather than by matching the numbers by hand.
resource "aws_s3_bucket_lifecycle_configuration" "security" {
  bucket = aws_s3_bucket.this["security"].id

  rule {
    id     = "expire-after-lock"
    status = "Enabled"

    filter {}

    expiration {
      days = var.security_lock_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = var.security_lock_retention_days
    }
  }
}
