variable "aws_region" {
  description = "AWS region this environment is provisioned in. Feeds the region-scoped feedback-smtp.<region>.amazonses.com hostname in the custom MAIL FROM MX record — SES's bounce/complaint feedback endpoint is regional, not global."
  type        = string
}

variable "zone_id" {
  description = "Public Route 53 hosted-zone ID owned by the shared bootstrap stack."
  type        = string
}

variable "create_email_records" {
  description = "Whether to provision the SES domain identity, DKIM, custom MAIL FROM and DMARC records for ses_domain. false (default) — most environments have no transactional-email-sending code yet; set true where they do."
  type        = bool
  default     = false

  validation {
    condition     = var.create_email_records ? var.ses_domain != null : true
    error_message = "ses_domain is required when create_email_records is true."
  }

  validation {
    condition     = var.create_email_records ? var.dmarc_rua != null : true
    error_message = "dmarc_rua is required when create_email_records is true — a DMARC record with no rua= is unverifiable, and \"DMARC reports received\" is an explicit acceptance criterion."
  }
}

variable "ses_domain" {
  description = <<-EOT
    Dedicated subdomain transactional email is sent from, e.g. "mail.studafy.com". Deliberately
    never the bare apex domain itself — isolates sending reputation from the apex/app domains, so a
    deliverability problem with transactional mail can't affect api.studafy.com or
    app.studafy.com. Required (no default) whenever create_email_records is true.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.ses_domain == null || can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.ses_domain))
    error_message = "ses_domain must be a bare hostname (e.g. \"mail.studafy.com\"), no scheme, no path."
  }
}

variable "mail_from_subdomain" {
  description = "Label prepended to ses_domain for SES's custom MAIL FROM domain, e.g. \"bounce\" -> \"bounce.mail.studafy.com\". Must be a subdomain of ses_domain, not ses_domain itself — SES rejects a MAIL FROM domain equal to the identity domain."
  type        = string
  default     = "bounce"
}

variable "dmarc_policy" {
  description = "DMARC enforcement policy published for ses_domain. This ticket's acceptance criteria call for \"quarantine\" specifically — do not tighten to \"reject\" without first confirming aggregate reports (dmarc_rua) show clean, consistent SPF/DKIM alignment."
  type        = string
  default     = "quarantine"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be one of: none, quarantine, reject."
  }
}

variable "dmarc_rua" {
  description = <<-EOT
    Aggregate DMARC report destination, as a full "mailto:" URI, e.g.
    "mailto:dmarc-reports@studafy.com". Deliberately has no default: this ticket's "DMARC
    reports received" acceptance criterion is meaningless without a real mailbox behind it, and
    this module provisions no mail-receiving infrastructure (no MX/inbox exists in this repo for
    the apex domain today). Required whenever create_email_records is true.
  EOT
  type        = string
  default     = null
}

variable "dmarc_ruf" {
  description = "Forensic (per-message failure) DMARC report destination, as a \"mailto:\" URI. null (default) omits ruf= from the record — aggregate reports (dmarc_rua) already satisfy the acceptance criteria, forensic reports leak raw message content, and most receivers ignore ruf= regardless."
  type        = string
  default     = null
}
