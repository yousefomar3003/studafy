# CloudFront distribution in front of the private web-bundle bucket (main.tf), reached only via
# Origin Access Control — never a public bucket policy, matching modules/storage's "private by
# default" posture even though this bucket's content is meant to be publicly readable through the
# CDN. Two cache behaviors implement the ticket's two cache classes:
#
#   - default (*):                 HTML no-cache. TTL 0 means every request is a miss forwarded to
#                                   the origin, so a new deploy is visible on the very next request
#                                   — "deploy busts HTML instantly" without depending on an
#                                   invalidation call to actually take effect (deploy.tf's
#                                   invalidation is still wired up as the ticket's explicit
#                                   deliverable and as defense-in-depth against any downstream
#                                   cache, but correctness here does not depend on it running).
#   - immutable_asset_path_pattern: long-cache, immutable. TTL 1 year, set by the cache policy
#                                   itself rather than trusting origin Cache-Control metadata — no
#                                   build/deploy tooling exists yet in this repo to set per-object
#                                   metadata on upload (same "nothing built to set this yet" gap as
#                                   modules/storage's SSE-S3-not-KMS reasoning), so the cache
#                                   behavior is self-contained instead of depending on it.
#
# custom_error_response maps S3's 403 (private bucket, no such key — OAC's "AccessDenied" for a
# path with no object) and 404 to a 200 index.html: apps/web is a client-side-routed SPA
# (react-router-dom in apps/web/package.json), so a deep-link refresh (e.g. /courses/42) has no
# matching S3 object and must fall through to the app shell, not a CDN-level 403/404 page.

resource "aws_cloudfront_origin_access_control" "web_bundle" {
  name                              = "${var.name_prefix}-web-bundle"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "html_no_cache" {
  name    = "${var.name_prefix}-cdn-html-no-cache"
  comment = "TTL 0: every request is forwarded to the origin, so a deploy is visible immediately."

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

resource "aws_cloudfront_cache_policy" "immutable_assets" {
  name    = "${var.name_prefix}-cdn-immutable-assets"
  comment = "Fixed ${var.immutable_asset_max_age_seconds}s TTL for content-hashed, never-overwritten filenames under ${var.immutable_asset_path_pattern}."

  min_ttl     = var.immutable_asset_max_age_seconds
  default_ttl = var.immutable_asset_max_age_seconds
  max_ttl     = var.immutable_asset_max_age_seconds

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

# Response headers policies set the literal Cache-Control header on the response, independent of
# the cache policies above — the cache policies above control what CloudFront does at the edge
# (how long it holds a copy), this controls what the client/any intermediate cache is told. The two
# are set to agree on purpose: a mismatched pair (e.g. edge caches 1 year but tells the browser
# no-cache) would make the ">90% cache-hit ratio" and "no-cache" criteria fight each other.
resource "aws_cloudfront_response_headers_policy" "html_no_cache" {
  name = "${var.name_prefix}-cdn-html-no-cache"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-cache"
      override = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "immutable_assets" {
  name = "${var.name_prefix}-cdn-immutable-assets"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=${var.immutable_asset_max_age_seconds}, immutable"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  comment             = "${var.name_prefix} web bundle"
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  price_class         = var.price_class
  retain_on_delete    = var.enable_deletion_protection

  origin {
    domain_name              = aws_s3_bucket.web_bundle.bucket_regional_domain_name
    origin_id                = aws_s3_bucket.web_bundle.id
    origin_access_control_id = aws_cloudfront_origin_access_control.web_bundle.id
  }

  default_cache_behavior {
    target_origin_id = aws_s3_bucket.web_bundle.id
    allowed_methods   = ["GET", "HEAD"]
    cached_methods    = ["GET", "HEAD"]
    compress          = true

    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id            = aws_cloudfront_cache_policy.html_no_cache.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.html_no_cache.id
  }

  ordered_cache_behavior {
    path_pattern     = var.immutable_asset_path_pattern
    target_origin_id = aws_s3_bucket.web_bundle.id
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    compress         = true

    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id            = aws_cloudfront_cache_policy.immutable_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.immutable_assets.id
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.this.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${var.name_prefix}-cdn" }
}

# Single combined bucket policy (main.tf's comment on this): CloudFront OAC read access, scoped to
# this exact distribution's ARN — not "any CloudFront distribution in the account" — so a different
# distribution someone creates later cannot read this bucket by pointing an OAC at it; plus the
# same deny-insecure-transport belt-and-suspenders statement modules/storage uses.
data "aws_iam_policy_document" "web_bundle" {
  statement {
    sid    = "AllowCloudFrontServicePrincipalReadOnly"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web_bundle.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.web_bundle.arn,
      "${aws_s3_bucket.web_bundle.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web_bundle" {
  bucket = aws_s3_bucket.web_bundle.id
  policy = data.aws_iam_policy_document.web_bundle.json
}
