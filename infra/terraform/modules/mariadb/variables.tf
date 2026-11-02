variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-staging\"."
  type        = string
}

variable "db_subnet_group_name" {
  description = "Name of the aws_db_subnet_group to launch into, e.g. module.network.db_subnet_group_name. The same subnet group modules/postgres uses — a subnet group is not engine-specific, so this module creates no second one."
  type        = string
}

variable "security_group_ids" {
  description = "Security group IDs to attach, e.g. [module.network.mariadb_security_group_id]. This module creates no security group of its own — network topology is the network module's job, same convention as modules/postgres."
  type        = list(string)

  validation {
    condition     = length(var.security_group_ids) > 0
    error_message = "security_group_ids must contain at least one security group."
  }
}

variable "port" {
  description = "TCP port MariaDB listens on. Must match the network module's mariadb_port so the security group rule and the engine port agree — pass both from the same root variable."
  type        = number
  default     = 3306

  validation {
    condition     = var.port > 0 && var.port <= 65535
    error_message = "port must be a valid TCP port (1-65535)."
  }
}

variable "engine_version" {
  description = "MariaDB engine version. 10.11 is an RDS-supported LTS line that satisfies Frappe's MariaDB floor (>= 10.3) — not a deeply researched pin, same honesty gap as modules/postgres's own engine_version default."
  type        = string
  default     = "10.11"

  validation {
    condition     = can(regex("^10\\.11", var.engine_version))
    error_message = "engine_version must be a 10.11.x release to match this module's mariadb10.11 parameter group family."
  }
}

variable "instance_class" {
  description = "RDS instance class for both members of the HA pair (primary + Multi-AZ standby). No researched staging/prod sizing exists yet — same honesty gap as modules/postgres's own instance_class."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  description = "Initial storage in GB (gp3). 20 is RDS's minimum for MariaDB on gp3."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage_gb >= 20
    error_message = "allocated_storage_gb must be at least 20 (RDS's gp3 minimum for MariaDB)."
  }
}

variable "max_allocated_storage_gb" {
  description = "Ceiling for RDS storage autoscaling. Must be at least allocated_storage_gb. Multiple schools' Frappe sites share this one instance (see README.md), so storage pressure grows with tenant count, not just per-tenant data volume."
  type        = number
  default     = 100

  validation {
    condition     = var.max_allocated_storage_gb >= var.allocated_storage_gb
    error_message = "max_allocated_storage_gb must be greater than or equal to allocated_storage_gb."
  }
}

variable "master_username" {
  description = "Master username. Deliberately not \"admin\" or \"root\" — same reasoning as modules/postgres's master_username."
  type        = string
  default     = "studafy_admin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]*$", var.master_username))
    error_message = "master_username must be lowercase alphanumeric/underscore, starting with a letter."
  }
}

variable "max_statement_time_seconds" {
  description = "MariaDB's max_statement_time server variable, in seconds (MariaDB's own unit — unlike Postgres's statement_timeout, this is not milliseconds). Protects against a runaway query exhausting the ERPNext plane's connection pool. 30s is a starting point, not a measured value, mirroring modules/postgres's statement_timeout_ms caveat."
  type        = number
  default     = 30

  validation {
    condition     = var.max_statement_time_seconds >= 0
    error_message = "max_statement_time_seconds must be >= 0 (0 disables the limit)."
  }
}

variable "slow_query_log_threshold_seconds" {
  description = "long_query_time: log any statement taking longer than this many seconds."
  type        = number
  default     = 1
}

variable "backup_retention_days" {
  description = "Days of automated backups to retain. 0 disables automated backups (Multi-AZ failover still works — it's replication-based, not backup-based)."
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
  description = "Reject terraform destroy / console deletion until this is turned off first. false by default (dev-equivalent); override true in staging/prod.tfvars."
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "If true, no final snapshot is taken on destroy. If false, destroy takes a snapshot named \"<name_prefix>-mariadb-final\" — same re-create caveat as modules/postgres's own skip_final_snapshot."
  type        = bool
  default     = false
}
