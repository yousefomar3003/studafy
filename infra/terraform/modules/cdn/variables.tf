variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "environment" {
  description = "Terraform environment (dev | staging | prod), matching the root module's var.environment. Scopes the deploy role's trust condition to the same-named GitHub Environment — not validated against the dev|staging|prod list here to avoid a second source of truth for that check (same reasoning as modules/registry's environment variable)."
  type        = string
}

variable "domain_name" {
  description = <<-EOT
    Public hostname the CDN serves the web bundle at, e.g. "app.studafy.com" or
    "staging.studafy.com". This is the host apps/web's built assets are actually deployed to — it
    intentionally matches the host portion of the root module's var.web_origin for the same
    environment, because the CDN's whole purpose is to serve that origin's static files. Kept as
    its own variable rather than parsed out of web_origin, matching the existing
    edge_domain_name / web_origin split (infra/terraform/variables.tf) where two related-but-
    distinct hosts are each an explicit value, not string surgery on the other.
  EOT
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a bare hostname (e.g. \"app.studafy.com\"), no scheme, no path."
  }
}

variable "route53_zone_id" {
  description = "Public hosted-zone ID owned by the shared bootstrap stack."
  type        = string
}

variable "create_dns_record" {
  description = "Whether to create/manage an alias A record for domain_name pointing at the CloudFront distribution in route53_zone_id. Set false if domain_name's record is managed elsewhere."
  type        = bool
  default     = true
}

variable "github_oidc_provider_arn" {
  description = <<-EOT
    ARN of the GitHub Actions OIDC provider to trust for the deploy role in deploy.tf. AWS allows
    exactly one OIDC provider per URL per account, and modules/registry already created
    "https://token.actions.githubusercontent.com" as an account-wide singleton (see the comment on
    aws_iam_openid_connect_provider.github_actions in modules/registry/main.tf, which explicitly
    calls for reuse over a second provider). Pass module.registry.github_oidc_provider_arn here —
    this module deliberately does not create its own.
  EOT
  type        = string
}

variable "github_repository" {
  description = "\"<owner>/<repo>\" GitHub slug allowed to assume the deploy role (scoped to the matching GitHub Environment) via OIDC. Defaults to the same repo modules/registry trusts."
  type        = string
  default     = "yousefomar3003/studafy"
}

variable "immutable_asset_path_pattern" {
  description = <<-EOT
    CloudFront path pattern matched against the long-cache, immutable cache behavior. Default
    "assets/*" is Vite's actual default build output layout (apps/web/vite.config.ts takes no
    build.assetsDir override, so `vite build` writes content-hashed JS/CSS/etc. under
    dist/assets/) — not a guess at a convention apps/web doesn't follow. Everything outside this
    pattern (index.html, and any other unhashed file at the bundle root) falls through to the
    default, no-cache behavior.
  EOT
  type        = string
  default     = "assets/*"
}

variable "immutable_asset_max_age_seconds" {
  description = "Cache-Control max-age (seconds) applied to objects matching immutable_asset_path_pattern, both as the CloudFront cache policy's TTL and as the literal response header value. Default 31536000 = 1 year, the conventional ceiling for content-hashed, never-overwritten filenames."
  type        = number
  default     = 31536000

  validation {
    condition     = var.immutable_asset_max_age_seconds >= 1
    error_message = "immutable_asset_max_age_seconds must be at least 1."
  }
}

variable "price_class" {
  description = <<-EOT
    CloudFront price class, controlling which edge locations serve this distribution.
    "PriceClass_100" (US, Canada, Europe) is the cheapest tier. No researched traffic-geography
    requirement exists yet for this project (same honesty gap as aws_region and redis_node_type in
    the root README) — override once one does.
  EOT
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be one of: PriceClass_100, PriceClass_200, PriceClass_All."
  }
}

variable "enable_deletion_protection" {
  description = "Whether the CloudFront distribution rejects deletion until this is turned off first (aws_cloudfront_distribution's retain_on_delete would keep it and its S3 origin behind on destroy, which is not what we want in dev/staging). false by default; override true in prod.tfvars — same pattern as edge_enable_deletion_protection."
  type        = bool
  default     = false
}

variable "force_destroy_bucket" {
  description = "Allow `terraform destroy` to delete the web-bundle bucket while it still has objects in it. Leave false outside dev, matching modules/storage's force_destroy."
  type        = bool
  default     = false
}

variable "noncurrent_version_expiration_days" {
  description = <<-EOT
    Days a noncurrent object version of the web-bundle bucket is kept before S3 deletes it.
    Versioning is on so a bad deploy can be rolled back by restoring the previous version; without
    this cleanup that becomes unbounded storage growth on every deploy (same reasoning as
    modules/storage's noncurrent-version rule). 30, not modules/storage's 90 — this bucket holds
    build output replaced on every deploy, not user data worth a quarter of rollback headroom.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_version_expiration_days >= 1
    error_message = "noncurrent_version_expiration_days must be at least 1."
  }
}
