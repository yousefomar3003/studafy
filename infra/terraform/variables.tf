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
