# Private S3 bucket holding apps/web's built bundle (`vite build`'s dist/). Not
# modules/storage's app-files bucket: that bucket is written by browsers via pre-signed URLs and
# CORS-scoped to var.web_origin; this bucket is written only by a deploy job (deploy.tf) and read
# only by CloudFront (via Origin Access Control, distribution.tf) — different writer, different
# reader, different lifecycle, so it gets its own bucket rather than a third prefix bulldozed into
# an unrelated module. Baseline hardening mirrors modules/storage: public access blocked,
# BucketOwnerEnforced, SSE-S3, deny-insecure-transport, versioned with noncurrent-version cleanup.

resource "aws_s3_bucket" "web_bundle" {
  bucket        = "${var.name_prefix}-web-bundle"
  force_destroy = var.force_destroy_bucket

  tags = { Name = "${var.name_prefix}-web-bundle" }
}

resource "aws_s3_bucket_ownership_controls" "web_bundle" {
  bucket = aws_s3_bucket.web_bundle.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "web_bundle" {
  bucket = aws_s3_bucket.web_bundle.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "web_bundle" {
  bucket = aws_s3_bucket.web_bundle.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web_bundle" {
  bucket = aws_s3_bucket.web_bundle.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The bucket policy itself (one statement here, one granting CloudFront OAC read access) is a
# single combined resource in distribution.tf's aws_s3_bucket_policy.web_bundle — S3 accepts
# exactly one policy document per bucket, so this cannot be a second aws_s3_bucket_policy resource
# without the two silently fighting over which one Terraform last applied.

resource "aws_s3_bucket_lifecycle_configuration" "web_bundle" {
  bucket = aws_s3_bucket.web_bundle.id

  depends_on = [aws_s3_bucket_versioning.web_bundle]

  rule {
    id     = "noncurrent-version-cleanup"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
  }
}
