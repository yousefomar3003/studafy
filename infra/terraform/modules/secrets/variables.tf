variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "services" {
  description = <<-EOT
    One app-secrets container per map key, at the canonical path
    "$${name_prefix}/<service>/app-secrets" (see main.tf). `shared_secret_arns` lists the ARNs of
    other modules' secrets (module.postgres/module.redis/module.pgbouncer's connection secrets)
    this service's IAM policy (iam.tf) should also be able to read — the root module is the only
    caller with access to those ARNs, so it assembles this map rather than this module guessing
    which shared secrets belong to which service.
  EOT
  type = map(object({
    shared_secret_arns = optional(list(string), [])
  }))

  validation {
    condition     = alltrue([for name, _ in var.services : can(regex("^[a-z][a-z0-9_]*$", name))])
    error_message = "each services key must be lowercase alphanumeric/underscore, starting with a letter (used verbatim as a Secrets Manager path segment)."
  }
}

variable "app_secret_values" {
  description = <<-EOT
    Per-service application secrets, e.g. { realtime = { WS_JWT_SECRET = "..." } }. Written into
    each service's app-secrets container as JSON (main.tf). Deliberately has no default and must
    never be set in a *.tfvars file — supply via TF_VAR_secrets_app_secret_values, the same
    convention infra/terraform/README.md already documents for WS_JWT_SECRET/REDIS_URL. A service
    present in var.services but absent here still gets its container created, holding "{}" — see
    main.tf's aws_secretsmanager_secret_version.app.
  EOT
  type        = map(map(string))
  default     = {}
  sensitive   = true
}

variable "postgres_connection_secret_arn" {
  description = "ARN of module.postgres's connection secret (host/port/dbname/username/password/sslmode). Rotation is attached to this exact secret — see rotation.tf."
  type        = string
}

variable "postgres_rotation_days" {
  description = "Days between automatic rotations of the Postgres master credential."
  type        = number
  default     = 30

  validation {
    condition     = var.postgres_rotation_days >= 1
    error_message = "postgres_rotation_days must be at least 1."
  }
}

variable "vpc_subnet_ids" {
  description = "Subnets the rotation Lambda's ENIs launch into, e.g. module.network.private_app_subnet_ids. Must route to the internet (NAT) for the Lambda's own Secrets Manager API calls, and be reachable from the database's security group — the private-app tier, not private-data (see module.network's README for which subnets have a NAT route)."
  type        = list(string)

  validation {
    condition     = length(var.vpc_subnet_ids) > 0
    error_message = "vpc_subnet_ids must contain at least one subnet."
  }
}

variable "security_group_ids" {
  description = "Security group IDs to attach to the rotation Lambda, e.g. [module.network.secrets_rotation_security_group_id]. This module creates no security group of its own — network topology is the network module's job, same convention as every other module here."
  type        = list(string)

  validation {
    condition     = length(var.security_group_ids) > 0
    error_message = "security_group_ids must contain at least one security group."
  }
}
