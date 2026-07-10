variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-staging\"."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID the target groups are created in, e.g. module.network.vpc_id."
  type        = string
}

variable "https_listener_arn" {
  description = <<-EOT
    ARN of module.edge's HTTPS listener. This module attaches aws_lb_listener_rule resources to
    it — exactly the extension point modules/edge's own README documents ("a future compute-tier
    module can attach target groups/listener rules... without editing this module"). Once these
    rules exist, the listener's own fixed-404 default_action becomes unreachable dead code (a
    path-pattern "/*" rule always matches first) — harmless, and left in place rather than edited,
    since modules/edge declares no opinion on what compute exists behind it.
  EOT
  type        = string
}

variable "api_container_port" {
  description = "Port apps/api's container listens on. Must match infra/deploy/ecs/api/task-definition.json.tpl's containerPort."
  type        = number
  default     = 3000
}

variable "realtime_container_port" {
  description = "Port apps/realtime's container listens on. Must match infra/deploy/ecs/realtime/task-definition.json.tpl's containerPort."
  type        = number
  default     = 3001
}

variable "health_check_path" {
  description = "Path both target groups use for their health check. Matches apps/api's and apps/realtime's shared /readyz contract (apps/api/README.md, apps/realtime/README.md) — readiness, not liveness (that's the container-level healthCheck in each task-definition template)."
  type        = string
  default     = "/readyz"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the api/realtime/workers ECS log groups this module pre-creates (the task-definition templates reference these group names directly)."
  type        = number
  default     = 30
}

variable "secrets_service_iam_policy_arns" {
  description = <<-EOT
    Map of service name -> IAM managed policy ARN, from module.secrets.service_iam_policy_arns.
    Attached to the shared task execution role (not a task role — none of api/realtime/workers/
    erpnext call the AWS SDK themselves, see infra/deploy/README.md's "Known gaps" #4) so that
    whichever secrets a task definition's own `secrets` array references (e.g. realtime's
    WS_JWT_SECRET, erpnext's MariaDB connection secret) can actually be resolved at task launch.
    One shared role for the whole cluster, scoped by the union of these policies, rather than a
    role per service — ECS task definitions reference exactly one executionRoleArn each, and
    nothing in this repo needs per-service execution-role isolation today.
  EOT
  type        = map(string)
  default     = {}
}
