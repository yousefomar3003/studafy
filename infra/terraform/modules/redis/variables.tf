variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "subnet_group_name" {
  description = "Name of the aws_elasticache_subnet_group to launch into, e.g. module.network.elasticache_subnet_group_name. Must span at least 2 AZs in the private-data tier."
  type        = string
}

variable "security_group_ids" {
  description = "Security group IDs to attach, e.g. [module.network.redis_security_group_id]. This module creates no security group of its own — network topology is the network module's job."
  type        = list(string)

  validation {
    condition     = length(var.security_group_ids) > 0
    error_message = "security_group_ids must contain at least one security group."
  }
}

variable "port" {
  description = "TCP port Redis listens on. Must match the network module's redis_port so the security group rule and the engine port agree — pass both from the same root variable."
  type        = number
  default     = 6379

  validation {
    condition     = var.port > 0 && var.port <= 65535
    error_message = "port must be a valid TCP port (1-65535)."
  }
}

variable "engine_version" {
  description = "Redis engine version. Must be a 7.x release — the module's parameter group family is hardcoded to redis7."
  type        = string
  default     = "7.1"

  validation {
    condition     = can(regex("^7\\.", var.engine_version))
    error_message = "engine_version must be a Redis 7.x release to match the redis7 parameter group family."
  }
}

variable "node_type" {
  description = <<-EOT
    ElastiCache node type for both members of the HA pair. No default is researched for
    staging/prod sizing yet (same honesty gap as aws_region in the root README) — cache.t4g.micro
    is a dev-appropriate default; override per environment via redis_node_type in *.tfvars once
    real traffic/memory numbers exist.
  EOT
  type        = string
  default     = "cache.t4g.micro"
}

variable "snapshot_retention_limit" {
  description = "Days of automatic daily snapshots to retain. 0 disables snapshots entirely."
  type        = number
  default     = 1

  validation {
    condition     = var.snapshot_retention_limit >= 0 && var.snapshot_retention_limit <= 35
    error_message = "snapshot_retention_limit must be between 0 and 35 (ElastiCache's own limit)."
  }
}

variable "snapshot_window" {
  description = "Daily UTC window for the automatic snapshot, e.g. \"03:00-05:00\". Must not overlap maintenance_window."
  type        = string
  default     = "03:00-05:00"
}

variable "maintenance_window" {
  description = "Weekly UTC window for engine patching, e.g. \"sun:05:00-sun:07:00\". Must not overlap snapshot_window."
  type        = string
  default     = "sun:05:00-sun:07:00"
}

variable "auto_minor_version_upgrade" {
  description = "Apply engine minor-version patches automatically during maintenance_window."
  type        = bool
  default     = true
}

variable "apply_immediately" {
  description = "Apply changes immediately instead of during the next maintenance window. Some changes (e.g. node_type) trigger a failover — leave false in staging/prod so that happens on a controlled schedule, not mid-deploy."
  type        = bool
  default     = false
}
