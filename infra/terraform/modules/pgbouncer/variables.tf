variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "subnet_id" {
  description = "Private-app subnet to launch the instance into, e.g. module.network.private_app_subnet_ids[0]. Single subnet, not a list: this module provisions one instance (see README's \"What this module does not do\"), so there is nothing to spread across AZs yet."
  type        = string
}

variable "security_group_ids" {
  description = "Security group IDs to attach, e.g. [module.network.pgbouncer_security_group_id]. This module creates no security group of its own — network topology is the network module's job."
  type        = list(string)

  validation {
    condition     = length(var.security_group_ids) > 0
    error_message = "security_group_ids must contain at least one security group."
  }
}

variable "postgres_connection_secret_arn" {
  description = "ARN of the Secrets Manager secret from module.postgres (connection_secret_arn) holding { host, port, dbname, username, password, sslmode }. Fetched by the instance at boot to render pgbouncer.ini and userlist.txt — never passed as a plain Terraform variable."
  type        = string
}

variable "listen_port" {
  description = "TCP port PgBouncer listens on. Must match the network module's pgbouncer_port so the security group rule and the listener agree — pass both from the same root variable."
  type        = number
  default     = 6432

  validation {
    condition     = var.listen_port > 0 && var.listen_port <= 65535
    error_message = "listen_port must be a valid TCP port (1-65535)."
  }
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type for the PgBouncer host. No default is researched for staging/prod connection
    volume yet (same honesty gap as modules/postgres's instance_class and modules/redis's node_type)
    — t3.micro is a dev-appropriate default; override per environment once real concurrent-connection
    numbers exist.
  EOT
  type        = string
  default     = "t3.micro"
}

variable "key_name" {
  description = "Name of an existing EC2 key pair for SSH access via the bastion (modules/network's pgbouncer_from_bastion rule). Optional — null means the instance has no SSH key at all and troubleshooting relies on the CloudWatch-shipped log and exported metrics."
  type        = string
  default     = null
}

variable "service_pools" {
  description = <<-EOT
    One PgBouncer [databases] entry per map key, all pointing at the same physical Postgres
    database (no per-service Postgres role exists yet — see docs/runbooks/postgres-conventions.md's
    "Known gaps" and this module's own README) but each with its own pool_size, so one noisy
    service cannot exhaust the connection budget meant for another. Keys default to the same three
    service names modules/registry's image_repository_names defaults to (api, realtime, workers) —
    keep the two lists in sync by hand if a new service is added; they are independent variables in
    different shapes (repo names vs. pool sizing), not worth coupling with a cross-module reference.
  EOT
  type = map(object({
    pool_size         = number
    reserve_pool_size = optional(number, 0)
  }))
  default = {
    api      = { pool_size = 20, reserve_pool_size = 5 }
    realtime = { pool_size = 10, reserve_pool_size = 0 }
    workers  = { pool_size = 10, reserve_pool_size = 5 }
  }

  validation {
    condition     = length(var.service_pools) > 0
    error_message = "service_pools must not be empty."
  }

  validation {
    condition     = contains(keys(var.service_pools), "api")
    error_message = "service_pools must contain api because the API runtime consumes that stable pool credential."
  }

  validation {
    condition     = alltrue([for name, _ in var.service_pools : can(regex("^[a-z][a-z0-9_]*$", name))])
    error_message = "each service_pools key must be lowercase alphanumeric/underscore, starting with a letter (used verbatim as a PgBouncer database name)."
  }
}

variable "max_client_conn" {
  description = "PgBouncer's max_client_conn — the hard ceiling on total client connections across every pool. Must be comfortably above the sum of service_pools' pool_size values or services will be rejected before their own pool limit is even reached."
  type        = number
  default     = 200

  validation {
    condition     = var.max_client_conn > 0
    error_message = "max_client_conn must be a positive number."
  }
}

variable "default_pool_size" {
  description = "PgBouncer's default_pool_size — fallback pool size for any database not listed in service_pools. Every database this module renders is explicit, so this is only a safety net, not an actively used value."
  type        = number
  default     = 20
}

variable "cloudwatch_metrics_namespace" {
  description = "CloudWatch custom-metric namespace the metrics-scraper script publishes pool saturation (cl_waiting, cl_active, sv_active, sv_idle, maxwait) to, one data point per service_pools entry."
  type        = string
  default     = "Studafy/PgBouncer"
}

variable "metrics_interval_seconds" {
  description = "How often the systemd timer runs SHOW POOLS/STATS against the admin console and pushes the result to CloudWatch."
  type        = number
  default     = 60

  validation {
    condition     = var.metrics_interval_seconds >= 10
    error_message = "metrics_interval_seconds must be at least 10 — CloudWatch's own PutMetricData resolution floor."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the shipped pgbouncer.log (connection/disconnection/pool events)."
  type        = number
  default     = 90
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GB."
  type        = number
  default     = 8
}
