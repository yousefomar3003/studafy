variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "web_origin" {
  description = <<-EOT
    The single browser origin (scheme + host, no path, no trailing slash) allowed to issue
    cross-origin requests against the app-files bucket for pre-signed uploads/downloads, e.g.
    "https://app.studafy.com" or "http://localhost:5173" in dev. Exactly one origin is accepted
    by design — the acceptance criterion is "CORS allows web origin only", not a list, and a
    wildcard would defeat the point of scoping pre-signed URLs to this app's own frontend.
  EOT
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.web_origin))
    error_message = "web_origin must be a bare scheme+host, e.g. \"https://app.studafy.com\" (no path, no trailing slash)."
  }
}

variable "temp_expiration_days" {
  description = "Days before objects under the temp/ prefix in app-files expire. 1 = the ticket's \"24h\" requirement; S3 lifecycle rules operate in whole days, not hours, so 1 day is the closest exact match, not an approximation."
  type        = number
  default     = 1

  validation {
    condition     = var.temp_expiration_days >= 1
    error_message = "temp_expiration_days must be at least 1 (S3 lifecycle expiration has no sub-day granularity)."
  }
}

variable "reports_expiration_days" {
  description = "Days before objects under the reports/ prefix in app-files expire. Matches the ticket's \"reports 7d\" requirement."
  type        = number
  default     = 7

  validation {
    condition     = var.reports_expiration_days >= 1
    error_message = "reports_expiration_days must be at least 1."
  }
}

variable "noncurrent_version_expiration_days" {
  description = <<-EOT
    Days a noncurrent object version is kept before S3 deletes it, applied bucket-wide on both
    buckets. Not named in the ticket, but required by combining it with versioning: versioning
    "on" with no noncurrent-version cleanup means every overwrite or delete keeps the prior
    version forever, which is unbounded storage growth, not a feature. No retention requirement
    has been researched for this project yet (same honesty gap as redis_node_type and aws_region
    in the root README) — 90 days is a placeholder, override per environment once a real
    retention policy exists.
  EOT
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_expiration_days >= 1
    error_message = "noncurrent_version_expiration_days must be at least 1."
  }
}

variable "abort_incomplete_multipart_days" {
  description = "Days before an incomplete multipart upload is aborted and its parts deleted, applied bucket-wide on both buckets. Pairs with allowing POST/PUT in CORS for pre-signed multipart uploads to app-files — an abandoned multipart upload (browser tab closed mid-upload) otherwise bills for its uploaded parts indefinitely."
  type        = number
  default     = 7

  validation {
    condition     = var.abort_incomplete_multipart_days >= 1
    error_message = "abort_incomplete_multipart_days must be at least 1."
  }
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete a bucket that still has objects in it. Leave false in staging/prod so destroying the wrong environment fails loudly instead of silently deleting data; dev may set this true to make throwaway testing easier."
  type        = bool
  default     = false
}
