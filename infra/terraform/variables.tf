variable "project" {
  description = "Project slug used as the prefix for every resource name."
  type        = string
  default     = "studafy"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.project))
    error_message = "project must be lowercase alphanumeric with hyphens, starting with a letter."
  }
}

variable "environment" {
  description = <<-EOT
    Infrastructure environment. Matches the mobile app's flavor short names
    (apps/mobile/lib/src/core/config/app_environment.dart). This is distinct from
    the services' runtime NODE_ENV (development|test|production).
  EOT
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region the environment's resources are provisioned in."
  type        = string
}

variable "extra_tags" {
  description = "Environment-specific tags merged on top of the canonical tag set."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for this environment's VPC. Kept non-overlapping across environments so they can be VPC-peered later without renumbering."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones the network module spreads subnets across (2 or 3)."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "true: one shared NAT gateway (cheaper). false: one NAT gateway per AZ (highly available)."
  type        = bool
  default     = true
}

variable "db_port" {
  description = "TCP port Postgres listens on. Shared between module.network (security group rule) and module.postgres (engine port) so the two can never drift apart — the network module's own db_port default exists only for callers that don't also provision this module."
  type        = number
  default     = 5432

  validation {
    condition     = var.db_port > 0 && var.db_port <= 65535
    error_message = "db_port must be a valid TCP port (1-65535)."
  }
}

variable "postgres_instance_class" {
  description = "RDS instance class for both members of the Postgres HA pair. db.t4g.micro is dev-appropriate only — no researched staging/prod sizing exists yet (same honesty gap as aws_region and redis_node_type above)."
  type        = string
  default     = "db.t4g.micro"
}

variable "postgres_deletion_protection" {
  description = "Whether the Postgres instance rejects deletion until this is turned off first. false by default (dev); override true in staging/prod.tfvars."
  type        = bool
  default     = false
}

variable "postgres_skip_final_snapshot" {
  description = "true: destroy takes no final snapshot (dev, disposable). false: destroy snapshots to a fixed name first (see modules/postgres/variables.tf for the re-create caveat) — set false in staging/prod.tfvars."
  type        = bool
  default     = true
}

variable "redis_port" {
  description = "TCP port Redis listens on. Shared between module.network (security group rule) and module.redis (engine port) so the two can never drift apart — the network module's own redis_port default exists only for callers that don't also provision this module."
  type        = number
  default     = 6379

  validation {
    condition     = var.redis_port > 0 && var.redis_port <= 65535
    error_message = "redis_port must be a valid TCP port (1-65535)."
  }
}

variable "redis_node_type" {
  description = "ElastiCache node type for both members of the Redis HA pair. cache.t4g.micro is dev-appropriate only — no researched staging/prod sizing exists yet (same honesty gap as aws_region above)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "bastion_allowed_ssh_cidrs" {
  description = <<-EOT
    CIDRs allowed to SSH into this environment's bastion. Deliberately has no default —
    supply per environment via TF_VAR_bastion_allowed_ssh_cidrs, the same way application
    secrets are passed (see README.md). Not committed to *.tfvars because it is
    operator/office-specific, not a stable environment fact.
  EOT
  type        = list(string)
}

variable "bastion_key_name" {
  description = <<-EOT
    Name of an existing EC2 key pair for this environment's bastion. Supply via
    TF_VAR_bastion_key_name; not committed to *.tfvars. Create the key pair out of band
    first — Terraform does not create it (see modules/network/README.md).
  EOT
  type        = string
}

variable "edge_domain_name" {
  description = <<-EOT
    Public hostname the load balancer (module.edge) serves for this environment, e.g.
    "api.studafy.com". staging and prod values are not guesses — they match what
    apps/mobile/lib/src/core/config/app_environment.dart already hardcodes as the API base URL
    for those flavors.
  EOT
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.edge_domain_name))
    error_message = "edge_domain_name must be a bare hostname (e.g. \"api.studafy.com\"), no scheme, no path."
  }
}

variable "route53_zone_name" {
  description = "Name of the existing public Route 53 hosted zone edge_domain_name lives in, e.g. \"studafy.com\". Looked up by module.edge, not created by Terraform."
  type        = string
}

variable "edge_create_dns_record" {
  description = "Whether module.edge manages the alias A record for edge_domain_name. See modules/edge/variables.tf's create_dns_record for when to set this false."
  type        = bool
  default     = true
}

variable "edge_enable_deletion_protection" {
  description = "Whether the ALB rejects deletion until this is turned off first. false by default (dev/staging); override true in prod.tfvars."
  type        = bool
  default     = false
}

variable "dns_manage_zone" {
  description = <<-EOT
    Whether this environment's state owns the aws_route53_zone resource for route53_zone_name
    (true) or only looks it up read-only (false, default) — see modules/dns/variables.tf's
    manage_zone. Set true in exactly one environment's tfvars (prod.tfvars); setting it true in
    more than one creates a second, competing public hosted zone with the same name.
  EOT
  type        = bool
  default     = false
}

variable "dns_protect_apex_from_spoofing" {
  description = "Whether module.dns publishes \"v=spf1 -all\" and a reject-policy DMARC record on the bare route53_zone_name apex. Only takes effect when dns_manage_zone is true. See modules/dns/variables.tf."
  type        = bool
  default     = true
}

variable "dns_create_email_records" {
  description = "Whether module.dns provisions the SES domain identity, DKIM, custom MAIL FROM and DMARC records for dns_ses_domain. false (default) — set true where an environment actually sends transactional email (prod.tfvars)."
  type        = bool
  default     = false
}

variable "dns_ses_domain" {
  description = "Dedicated subdomain transactional email is sent from, e.g. \"mail.studafy.com\". Required whenever dns_create_email_records is true — see modules/dns/variables.tf's ses_domain for why this is never route53_zone_name itself."
  type        = string
  default     = null
}

variable "dns_mail_from_subdomain" {
  description = "Label prepended to dns_ses_domain for SES's custom MAIL FROM domain, e.g. \"bounce\" -> \"bounce.mail.studafy.com\". See modules/dns/variables.tf's mail_from_subdomain."
  type        = string
  default     = "bounce"
}

variable "dns_dmarc_policy" {
  description = "DMARC enforcement policy published for dns_ses_domain: none, quarantine or reject. This ticket's acceptance criteria call for \"quarantine\"; see modules/dns/variables.tf's dmarc_policy before tightening to \"reject\"."
  type        = string
  default     = "quarantine"
}

variable "dns_dmarc_rua" {
  description = <<-EOT
    Aggregate DMARC report destination for dns_ses_domain, as a "mailto:" URI, e.g.
    "mailto:dmarc-reports@studafy.com". Required whenever dns_create_email_records is true — see
    modules/dns/variables.tf's dmarc_rua for why this has no default.
  EOT
  type        = string
  default     = null
}

variable "dns_dmarc_ruf" {
  description = "Forensic DMARC report destination for dns_ses_domain, as a \"mailto:\" URI. null (default) omits ruf= from the record. See modules/dns/variables.tf's dmarc_ruf."
  type        = string
  default     = null
}

variable "web_origin" {
  description = <<-EOT
    Scheme+host of the apps/web frontend for this environment, e.g. "https://app.studafy.com" or
    "http://localhost:5173" in dev. This is the only origin module.storage's CORS configuration
    allows on the app-files bucket. Public information (it's a frontend URL), so unlike the
    bastion variables above it is committed per environment in *.tfvars, not passed via TF_VAR_*.
  EOT
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.web_origin))
    error_message = "web_origin must be a bare scheme+host, e.g. \"https://app.studafy.com\" (no path, no trailing slash)."
  }
}
