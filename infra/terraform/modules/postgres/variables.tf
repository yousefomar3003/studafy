variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "db_subnet_group_name" {
  description = "Name of the aws_db_subnet_group to launch into, e.g. module.network.db_subnet_group_name. Must span at least 2 AZs in the private-data tier."
  type        = string
}

variable "security_group_ids" {
  description = "Security group IDs to attach, e.g. [module.network.db_security_group_id]. This module creates no security group of its own — network topology is the network module's job."
  type        = list(string)

  validation {
    condition     = length(var.security_group_ids) > 0
    error_message = "security_group_ids must contain at least one security group."
  }
}

variable "port" {
  description = "TCP port Postgres listens on. Must match the network module's db_port so the security group rule and the engine port agree — pass both from the same root variable."
  type        = number
  default     = 5432

  validation {
    condition     = var.port > 0 && var.port <= 65535
    error_message = "port must be a valid TCP port (1-65535)."
  }
}

variable "engine_version" {
  description = "Postgres engine version. Must be a 16.x release — the module's parameter group family is hardcoded to postgres16."
  type        = string
  default     = "16.4"

  validation {
    condition     = can(regex("^16\\.", var.engine_version))
    error_message = "engine_version must be a Postgres 16.x release to match the postgres16 parameter group family."
  }
}

variable "instance_class" {
  description = <<-EOT
    RDS instance class for both members of the HA pair (primary + Multi-AZ standby). No default is
    researched for staging/prod sizing yet (same honesty gap as aws_region and redis_node_type in
    the root README) — db.t4g.micro is a dev-appropriate default; override per environment via
    postgres_instance_class in *.tfvars once real traffic/query-latency numbers exist.
  EOT
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  description = "Initial storage in GB (gp3). 20 is RDS's minimum for Postgres on gp3."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage_gb >= 20
    error_message = "allocated_storage_gb must be at least 20 (RDS's gp3 minimum for Postgres)."
  }
}

variable "max_allocated_storage_gb" {
  description = "Ceiling for RDS storage autoscaling (gp3 grows automatically under sustained space pressure, up to this value). Must be at least allocated_storage_gb."
  type        = number
  default     = 100

  validation {
    condition     = var.max_allocated_storage_gb >= var.allocated_storage_gb
    error_message = "max_allocated_storage_gb must be greater than or equal to allocated_storage_gb."
  }
}

variable "database_name" {
  description = "Name of the initial database created on the instance."
  type        = string
  default     = "studafy"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]*$", var.database_name))
    error_message = "database_name must be lowercase alphanumeric/underscore, starting with a letter."
  }
}

variable "master_username" {
  description = "Master username. Deliberately not \"postgres\" or \"admin\" — those are the first two guesses in any credential-stuffing attempt against a database endpoint."
  type        = string
  default     = "studafy_admin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]*$", var.master_username))
    error_message = "master_username must be lowercase alphanumeric/underscore, starting with a letter."
  }
}

variable "statement_timeout_ms" {
  description = <<-EOT
    Server-side statement_timeout in milliseconds, applied to every connection. Protects against a
    runaway or lock-held query exhausting the app tier's connection pool. 30s is a starting point,
    not a measured value — no query-latency profile exists yet for this app; revisit once one does.
  EOT
  type        = number
  default     = 30000

  validation {
    condition     = var.statement_timeout_ms >= 0
    error_message = "statement_timeout_ms must be >= 0 (0 disables the timeout)."
  }
}

variable "log_min_duration_statement_ms" {
  description = "Log any statement taking longer than this many milliseconds. -1 disables slow-query logging."
  type        = number
  default     = 1000
}

variable "backup_retention_days" {
  description = "Days of automated backups to retain. 0 disables automated backups (and Multi-AZ failover still works, since it's replication-based, not backup-based)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 0 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 0 and 35 (RDS's own limit)."
  }
}

variable "backup_window" {
  description = "Daily UTC window for the automated backup, e.g. \"03:00-05:00\". Must not overlap maintenance_window."
  type        = string
  default     = "03:00-05:00"
}

variable "maintenance_window" {
  description = "Weekly UTC window for engine patching, e.g. \"sun:05:00-sun:07:00\". Must not overlap backup_window."
  type        = string
  default     = "sun:05:00-sun:07:00"
}

variable "auto_minor_version_upgrade" {
  description = "Apply engine minor-version patches automatically during maintenance_window."
  type        = bool
  default     = true
}

variable "apply_immediately" {
  description = "Apply changes immediately instead of during the next maintenance window. Some changes (e.g. instance_class) trigger a failover — leave false in staging/prod so that happens on a controlled schedule, not mid-deploy."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Reject terraform destroy / console deletion until this is turned off first. false by default (dev); override true in staging/prod.tfvars."
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = <<-EOT
    If true, no final snapshot is taken on destroy — appropriate for dev, where the instance is
    disposable. If false, destroy takes a snapshot named "<name_prefix>-postgres-final"; a second
    destroy after a re-create will collide with that fixed name and fail until the old snapshot is
    removed manually. That's an accepted operational gap, not a hidden one: this module has no
    caller yet that destroys and recreates staging/prod repeatedly.
  EOT
  type        = bool
  default     = false
}
