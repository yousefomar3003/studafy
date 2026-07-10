variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\". Used only for the Name tag on resources this module creates — a hosted zone's and SES identity's actual names are fixed domain names, not name_prefix-derived."
  type        = string
}

variable "aws_region" {
  description = "AWS region this environment is provisioned in. Feeds the region-scoped feedback-smtp.<region>.amazonses.com hostname in the custom MAIL FROM MX record — SES's bounce/complaint feedback endpoint is regional, not global."
  type        = string
}

variable "zone_name" {
  description = "Apex domain of the public Route 53 hosted zone, e.g. \"studafy.com\". Same value every environment already passes as route53_zone_name to module.edge — one zone, either owned here (manage_zone = true) or looked up read-only, exactly like module.edge already does."
  type        = string
}

variable "manage_zone" {
  description = <<-EOT
    true: this environment's state owns aws_route53_zone.this and is authoritative for
    zone_name. false (default): the zone is looked up via a data source — this environment
    reads/writes records into it but does not own its lifecycle, same pattern module.edge
    already uses for route53_zone_name.

    Set true in exactly one environment's tfvars. Setting it true in more than one creates a
    second public hosted zone with the same name but a different NS delegation — only one can
    ever be the zone the registrar actually points at. See main.tf's import note before the
    first apply with this set true against a domain that already resolves.
  EOT
  type        = bool
  default     = false
}

variable "protect_apex_from_spoofing" {
  description = "Whether to publish \"v=spf1 -all\" and a reject-policy DMARC record on the bare zone_name apex, declaring that the apex itself never sends mail. Only takes effect when manage_zone is true — an environment that doesn't own the zone has no business writing apex-wide policy into it."
  type        = bool
  default     = true
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
    never zone_name itself — isolates sending reputation from the apex/app domains, so a
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
    zone_name today). Required whenever create_email_records is true.
  EOT
  type        = string
  default     = null
}

variable "dmarc_ruf" {
  description = "Forensic (per-message failure) DMARC report destination, as a \"mailto:\" URI. null (default) omits ruf= from the record — aggregate reports (dmarc_rua) already satisfy the acceptance criteria, forensic reports leak raw message content, and most receivers ignore ruf= regardless."
  type        = string
  default     = null
}
