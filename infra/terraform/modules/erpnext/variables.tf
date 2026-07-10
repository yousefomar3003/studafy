variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-staging\"."
  type        = string
}

variable "aws_region" {
  description = "AWS region, for the awslogs log driver configuration."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID the internal ALB and its target group are created in, e.g. module.network.vpc_id."
  type        = string
}

variable "frontend_port" {
  description = "Port the frontend (nginx) role listens on. Must match module.network's erpnext_port — the security group rule and the ALB target group's port must agree, same convention as db_port/redis_port elsewhere in this repo."
  type        = number
  default     = 8080
}

variable "cluster_arn" {
  description = "ECS cluster ARN to run ERPNext's services in, e.g. module.compute.cluster_arn. The ERPNext plane shares the same cluster as api/realtime/workers rather than provisioning a second one — one more thing this module doesn't need an opinion on."
  type        = string
}

variable "execution_role_arn" {
  description = "Shared ECS task-execution role ARN, e.g. module.compute.execution_role_arn. Must already have secretsmanager:GetSecretValue on erpnext_secret_arn/mariadb_connection_secret_arn/redis_auth_secret_arn attached (module.secrets' service_iam_policy_arns[\"erpnext\"], attached to the execution role by module.compute)."
  type        = string
}

variable "private_app_subnet_ids" {
  description = "Private app-tier subnet IDs, e.g. module.network.private_app_subnet_ids. ERPNext's ECS tasks and EFS mount targets both launch here — not private-data, since that tier has no NAT route and these tasks need outbound access for ECR pulls/Secrets Manager."
  type        = list(string)

  validation {
    condition     = length(var.private_app_subnet_ids) > 0
    error_message = "private_app_subnet_ids must contain at least one subnet."
  }
}

variable "security_group_id" {
  description = "Security group ID for both the ECS tasks and the EFS mount targets, e.g. module.network.erpnext_security_group_id. Ingress is scoped to the app tier only — this is the actual enforcement of \"reachable only from the integration gateway\", not the Service Connect namespace below (DNS resolution is a convenience layer, not a security boundary)."
  type        = string
}

variable "image_repository_url" {
  description = "ECR repository URL for this repo's own erpnext.Dockerfile build (module.registry.repository_urls[\"erpnext\"]), used by the backend/websocket/queue/scheduler roles — all bench roles that need the Education app installed on top of stock ERPNext. See infra/docker/erpnext.Dockerfile."
  type        = string
}

variable "image_tag" {
  description = "Tag of image_repository_url to deploy. Bumping this and re-applying is how an ERPNext image update ships — there is no rolling-deploy script for this plane the way infra/deploy/scripts/deploy.sh gives api/realtime/workers; see README.md's Known gaps for why that's an accepted trade-off here."
  type        = string
  default     = "latest"
}

variable "frontend_image" {
  description = "Full image reference for the frontend (nginx reverse-proxy) role. Deliberately the stock upstream frappe/erpnext-nginx image, not this repo's own erpnext ECR repository — nginx doesn't run bench and doesn't need the Education app installed, so there is nothing this repo's Dockerfile would add."
  type        = string
  default     = "frappe/erpnext-nginx:version-15"
}

variable "mariadb_address" {
  description = "MariaDB write endpoint (host only), e.g. module.mariadb.address. Not sensitive — passed as a plain container environment variable, not through secrets."
  type        = string
}

variable "mariadb_port" {
  description = "MariaDB port. Must match module.network's mariadb_port."
  type        = number
  default     = 3306
}

variable "mariadb_connection_secret_arn" {
  description = "module.mariadb.connection_secret_arn. Only the :password:: key is actually injected (via the execution role, as an ECS `secrets` entry) — host/port arrive as plain environment variables above, matching this repo's existing convention of not routing non-sensitive connection fields through Secrets Manager unnecessarily."
  type        = string
}

variable "redis_primary_endpoint_address" {
  description = "module.redis.primary_endpoint_address. Not sensitive."
  type        = string
}

variable "redis_port" {
  description = "Redis port. Must match module.network's redis_port."
  type        = number
  default     = 6379
}

variable "redis_cache_db" {
  description = "Logical Redis DB index for ERPNext's cache (docs/runbooks/redis-conventions.md's DB-assignment table)."
  type        = number
  default     = 2
}

variable "redis_queue_db" {
  description = "Logical Redis DB index for ERPNext's background-job queue (bench worker/RQ) — distinct from apps/workers' own BullMQ queue DB, even though both are \"queues\", because they are two unrelated job systems that must never share keyspace."
  type        = number
  default     = 3
}

variable "redis_auth_secret_arn" {
  description = "module.redis.auth_secret_arn. Only the :auth_token:: key is injected as a secret."
  type        = string
}

variable "erpnext_secret_arn" {
  description = <<-EOT
    ARN of the erpnext service's own app-secrets container, i.e. module.secrets output
    service_secret_arns["erpnext"] — holding ADMIN_PASSWORD and ENCRYPTION_KEY. Generated at the
    root module (random_password resources feeding module.secrets' app_secret_values), not by this
    module — module.secrets already owns "one app-secrets container per service" at the canonical
    "$${name_prefix}/erpnext/app-secrets" path; this module would collide with it if it tried to
    create a second secret at the same name.
  EOT
  type        = string
}

variable "backend_cpu" {
  type    = number
  default = 512
}

variable "backend_memory" {
  type    = number
  default = 1024
}

variable "backend_desired_count" {
  type    = number
  default = 1
}

variable "frontend_cpu" {
  type    = number
  default = 256
}

variable "frontend_memory" {
  type    = number
  default = 512
}

variable "frontend_desired_count" {
  type    = number
  default = 1
}

variable "websocket_cpu" {
  type    = number
  default = 256
}

variable "websocket_memory" {
  type    = number
  default = 512
}

variable "websocket_desired_count" {
  type    = number
  default = 1
}

variable "queue_cpu" {
  description = "CPU for the combined worker service. Staging runs the short/default/long RQ queues as one bench worker process, not three separate ECS services — see README.md's KISS note."
  type        = number
  default     = 512
}

variable "queue_memory" {
  type    = number
  default = 1024
}

variable "queue_desired_count" {
  type    = number
  default = 1
}

variable "scheduler_cpu" {
  type    = number
  default = 256
}

variable "scheduler_memory" {
  type    = number
  default = 512
}

variable "log_retention_days" {
  type    = number
  default = 30
}
