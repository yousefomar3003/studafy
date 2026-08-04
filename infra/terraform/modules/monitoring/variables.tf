variable "name_prefix" {
  description = "Canonical resource prefix, for example studafy-prod."
  type        = string
}

variable "aws_region" {
  description = "Region displayed by the dashboard widgets."
  type        = string
}

variable "postgres_instance_id" {
  description = "PostgreSQL RDS DBInstanceIdentifier."
  type        = string
}

variable "postgres_read_replica_instance_id" {
  description = "PostgreSQL reporting read-replica DBInstanceIdentifier."
  type        = string
}

variable "mariadb_instance_id" {
  description = "MariaDB DBInstanceIdentifier, or null where the ERPNext plane is disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "redis_replication_group_id" {
  description = "ElastiCache replication group identifier."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster containing the application services."
  type        = string
}

# --- Synthetic realtime probe (ST-149) ----------------------------------------------------------

variable "probe_enabled" {
  description = "Whether to provision the synthetic realtime probe: an EventBridge-scheduled Lambda that connects a probe client, publishes a test event through Redis and measures end-to-end propagation against probe_slo_ms. Enabled for staging/prod."
  type        = bool
  default     = false
}

variable "realtime_ws_url" {
  description = "Public wss:// URL of the realtime gateway's /ws handshake, e.g. wss://api.studafy.com/ws. The probe connects here to exercise the real client path (DNS, ALB, TLS, WAF) rather than the internal target group."
  type        = string
}

variable "realtime_jwt_secret_arn" {
  description = "ARN of the realtime service's app-secrets container (module.secrets) holding WS_JWT_SECRET, the HS256 secret the probe signs its handshake token with."
  type        = string
}

variable "redis_auth_secret_arn" {
  description = "ARN of module.redis's connection secret; the probe reads its pubsub_url field to publish the test event."
  type        = string
}

variable "probe_subnet_ids" {
  description = "Private app-tier subnet IDs the probe Lambda runs in — it must reach Redis (private) and, via NAT, the public ALB and AWS service endpoints."
  type        = list(string)
}

variable "probe_security_group_ids" {
  description = "Security group IDs attached to the probe Lambda. Pass module.network's app security group: its existing egress rules already cover Redis, HTTPS (443) and DNS, and its ingress rules are irrelevant to a Lambda (nothing connects in)."
  type        = list(string)
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the probe Lambda's log group, in days."
  type        = number
  default     = 30
}

variable "probe_metric_namespace" {
  description = "CloudWatch namespace the probe publishes RealtimeProbeLatency under. Follows the existing Studafy/<component> convention (pgbouncer uses Studafy/PgBouncer); the probe measures the realtime pipeline end-to-end, hence Studafy/Realtime."
  type        = string
  default     = "Studafy/Realtime"
}

variable "probe_slo_ms" {
  description = "Realtime propagation SLO in milliseconds. The probe alarm fires when measured latency exceeds this, or when the probe stops reporting (missing data is treated as breaching)."
  type        = number
  default     = 2000

  validation {
    condition     = var.probe_slo_ms > 0
    error_message = "probe_slo_ms must be a positive number of milliseconds."
  }
}
