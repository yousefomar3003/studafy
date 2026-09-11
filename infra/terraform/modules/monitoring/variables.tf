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

# --- Prometheus/Grafana metrics stack (ST-259) ---------------------------------------------------

variable "monitoring_enabled" {
  description = "Whether to provision Prometheus, Grafana and the DB exporters. Dev omits the whole stack (same reasoning as probe_enabled: no separate environment to page on, and Container Insights/CloudWatch already cover dev's own needs); staging/prod pass true."
  type        = bool
  default     = false
}

variable "vpc_id" {
  description = "VPC ID the Cloud Map private DNS namespace (Prometheus's scrape-target discovery) is created in."
  type        = string
}

variable "cluster_arn" {
  description = "ECS cluster ARN (module.compute) the Prometheus/Grafana/exporter services run in."
  type        = string
}

variable "execution_role_arn" {
  description = "Shared ECS task execution role ARN (module.compute) — reused here exactly as modules/erpnext reuses it, rather than this module creating its own. Its secrets-read policy for the \"monitoring\" service key (module.secrets, attached in root main.tf the same way every other service is) is what lets the exporter/Grafana task definitions resolve monitoring_secret_arn."
  type        = string
}

variable "private_app_subnet_ids" {
  description = "Private app-tier subnet IDs the monitoring plane's Fargate tasks run in."
  type        = list(string)
}

variable "monitoring_security_group_id" {
  description = "Security group ID for the monitoring plane (module.network's aws_security_group.monitoring): Grafana reachable only from the bastion, egresses to the app tier/db/mariadb it scrapes."
  type        = string
}

variable "metrics_port" {
  description = "Port apps/api, apps/realtime and apps/workers each expose their Prometheus-format /metrics endpoint on (ST-259). Must match module.network's metrics_port and each service's own METRICS_PORT env var."
  type        = number
  default     = 9464
}

variable "grafana_port" {
  description = "Port Grafana listens on. Must match module.network's grafana_port."
  type        = number
  default     = 3000
}

variable "monitoring_secret_arn" {
  description = "ARN of module.secrets's \"monitoring\" app-secrets container, holding POSTGRES_EXPORTER_DSN, MYSQLD_EXPORTER_DSN (only read when mariadb_exporter_enabled) and GRAFANA_ADMIN_PASSWORD. Assembled and supplied the same way REDIS_URL/DATABASE_URL are (infra/terraform/README.md) — Terraform never sees the plaintext DSNs, only this container's ARN."
  type        = string
}

variable "mariadb_exporter_enabled" {
  description = "Whether to provision mysqld_exporter against the ERPNext plane's MariaDB instance. Should match local.erpnext_plane_enabled in the root module — there is nothing to export when that plane doesn't exist."
  type        = bool
  default     = false
}

variable "prometheus_image" {
  description = "Full image reference (registry/repo:tag) for the Prometheus image this repo builds (infra/docker/prometheus.Dockerfile), pushed to module.registry's \"prometheus\" repository."
  type        = string
}

variable "grafana_image" {
  description = "Full image reference (registry/repo:tag) for the Grafana image this repo builds (infra/docker/grafana.Dockerfile), pushed to module.registry's \"grafana\" repository."
  type        = string
}

variable "prometheus_retention" {
  description = "How long Prometheus retains scraped samples (its own --storage.tsdb.retention.time duration syntax, e.g. \"15d\"). Bounded by Fargate's ephemeral task storage (prometheus_storage_gb) — see this module's README for why there is no persistent volume yet."
  type        = string
  default     = "15d"
}

variable "prometheus_storage_gb" {
  description = "Fargate ephemeral storage (GiB) for the Prometheus task. 21-200; 20 is Fargate's own included minimum, so this is deliberately the first paid increment above it."
  type        = number
  default     = 30

  validation {
    condition     = var.prometheus_storage_gb >= 21 && var.prometheus_storage_gb <= 200
    error_message = "prometheus_storage_gb must be between 21 and 200 (Fargate's ephemeral-storage range above its free 20GiB default)."
  }
}

variable "prometheus_cpu" {
  description = "Fargate CPU units for the Prometheus task."
  type        = number
  default     = 512
}

variable "prometheus_memory" {
  description = "Fargate memory (MiB) for the Prometheus task."
  type        = number
  default     = 1024
}

variable "grafana_cpu" {
  description = "Fargate CPU units for the Grafana task."
  type        = number
  default     = 256
}

variable "grafana_memory" {
  description = "Fargate memory (MiB) for the Grafana task."
  type        = number
  default     = 512
}

variable "exporter_cpu" {
  description = "Fargate CPU units for each DB exporter task (postgres_exporter, mysqld_exporter)."
  type        = number
  default     = 256
}

variable "exporter_memory" {
  description = "Fargate memory (MiB) for each DB exporter task."
  type        = number
  default     = 512
}

# --- Distributed tracing pipeline (ST-260) -------------------------------------------------------

variable "otel_collector_port" {
  description = "Port the OTel collector's OTLP/HTTP receiver listens on, and Tempo's own OTLP receiver (tracing.tf reuses the same port for both — see that file's own comment). Must match module.network's otel_collector_port and each service's own OTEL_EXPORTER_OTLP_ENDPOINT."
  type        = number
  default     = 4318
}

variable "otel_collector_image" {
  description = "Full image reference (registry/repo:tag) for the OTel collector image this repo builds (infra/docker/otel-collector.Dockerfile), pushed to module.registry's \"otel-collector\" repository."
  type        = string
}

variable "tempo_image" {
  description = "Full image reference (registry/repo:tag) for the Tempo image this repo builds (infra/docker/tempo.Dockerfile), pushed to module.registry's \"tempo\" repository."
  type        = string
}

variable "otel_collector_cpu" {
  description = "Fargate CPU units for the OTel collector task."
  type        = number
  default     = 256
}

variable "otel_collector_memory" {
  description = "Fargate memory (MiB) for the OTel collector task."
  type        = number
  default     = 512
}

variable "tempo_cpu" {
  description = "Fargate CPU units for the Tempo task."
  type        = number
  default     = 512
}

variable "tempo_memory" {
  description = "Fargate memory (MiB) for the Tempo task."
  type        = number
  default     = 1024
}

variable "tempo_storage_gb" {
  description = "Fargate ephemeral storage (GiB) for the Tempo task, same reasoning as prometheus_storage_gb: no persistent volume, traces live on the task's own ephemeral disk (see infra/docker/tempo/tempo.yaml's 24h block_retention and this module's README)."
  type        = number
  default     = 21

  validation {
    condition     = var.tempo_storage_gb >= 21 && var.tempo_storage_gb <= 200
    error_message = "tempo_storage_gb must be between 21 and 200 (Fargate's ephemeral-storage range above its free 20GiB default)."
  }
}

# --- Alerting and on-call (ST-262) ---------------------------------------------------------------

variable "alertmanager_image" {
  description = "Full image reference (registry/repo:tag) for the Alertmanager image this repo builds (infra/docker/alertmanager.Dockerfile), pushed to module.registry's \"alertmanager\" repository."
  type        = string
}

variable "alertmanager_port" {
  description = "Port Alertmanager serves its API and UI on. Must match module.network's alertmanager_port and the `alerting` block in infra/docker/prometheus/prometheus.yml, which hardcodes it for the same reason every other port in that file is hardcoded (see its header)."
  type        = number
  default     = 9093
}

variable "alertmanager_cpu" {
  description = "Fargate CPU units for the Alertmanager task."
  type        = number
  default     = 256
}

variable "alertmanager_memory" {
  description = "Fargate memory (MiB) for the Alertmanager task."
  type        = number
  default     = 512
}

variable "edge_certificate_arn" {
  description = "ARN of module.edge's validated ACM certificate (the public ALB's TLS certificate, in var.aws_region). Watched for expiry — see alerts.tf's own comment on why an auto-renewing certificate is still worth alerting on."
  type        = string
}

variable "cdn_certificate_arn" {
  description = "ARN of module.cdn's validated ACM certificate, which CloudFront requires to be in us-east-1. Null where there is no CDN (dev), which drops both of its expiry alarms and the us-east-1 SNS topic that would carry them."
  type        = string
  default     = null
  nullable    = true
}

# --- Black-box synthetic availability probes (ST-263) --------------------------------------------

variable "synthetics_enabled" {
  description = "Whether to provision the black-box synthetic probes (login page, /healthz, OAuth start, checkout page, invitation verify) in both var.aws_region and synthetics_dr_region. Enabled for staging/prod, same reasoning as probe_enabled: dev has no publicly reachable web_origin/edge_domain_name for an external probe to reach."
  type        = bool
  default     = false
}

variable "web_origin" {
  description = "Scheme+host of the apps/web frontend (root's var.web_origin, e.g. https://app.studafy.com). Builds the login-page and checkout-page (/pricing — see synthetics.tf) probe URLs."
  type        = string
}

variable "api_origin" {
  description = "Scheme+host of the apps/api origin (root assembles this as \"https://$${var.edge_domain_name}\", the same way realtime_ws_url is assembled from edge_domain_name above). Builds the /healthz, OAuth-start and invitation-verify probe URLs."
  type        = string
}

variable "synthetics_dr_region" {
  description = "Second AWS region the synthetic probe also runs from (root passes var.backup_dr_region — see versions.tf's header for why that alias, not a new one, satisfies ST-263's 'per region' / 'regional failure alerts' acceptance criteria)."
  type        = string
}

variable "synthetics_metric_namespace" {
  description = "CloudWatch namespace the synthetics probe publishes SyntheticCheckSuccess/SyntheticCheckLatency under. Same Studafy/<component> convention as probe_metric_namespace."
  type        = string
  default     = "Studafy/Synthetics"
}

variable "synthetics_availability_slo_percent" {
  description = "Proposed per-check availability SLO (NFR-03), as a percent, rendered as the availability dashboard's annotation line. No NFR-03 document exists anywhere in this repo — checked docs/, same honesty gap docs/testing/load-test-scenarios.md records for NFR-01/02 — so 99.9 is a conventional default, not a transcription of a real target. Whoever holds the real NFR-03 number should override this rather than have this value read as one."
  type        = number
  default     = 99.9

  validation {
    condition     = var.synthetics_availability_slo_percent > 0 && var.synthetics_availability_slo_percent <= 100
    error_message = "synthetics_availability_slo_percent must be a percent in (0, 100]."
  }
}
