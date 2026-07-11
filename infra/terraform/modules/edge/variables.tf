variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs the ALB is placed in, from module.network.public_subnet_ids. Must span at least 2 AZs (an AWS ALB requirement)."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "public_subnet_ids must contain at least 2 subnet IDs — an ALB requires at least 2 AZs."
  }
}

variable "alb_security_group_id" {
  description = "Security group ID for the load balancer, from module.network.alb_security_group_id. That group already scopes ingress to alb_ingress_cidrs on 80/443 and egress to the app tier's app_ports — this module attaches to it rather than creating a second one, so there is exactly one place network reachability into the edge is defined."
  type        = string
}

variable "domain_name" {
  description = "Public hostname the ALB serves, e.g. \"api.studafy.com\". Must already resolve inside route53_zone_id's zone — this module does not register a domain."
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a bare hostname (e.g. \"api.studafy.com\"), no scheme, no path."
  }
}

variable "route53_zone_id" {
  description = "Public hosted-zone ID owned by the shared bootstrap stack."
  type        = string
}

variable "create_dns_record" {
  description = "Whether to create/manage an alias A record for domain_name pointing at the ALB in route53_zone_id. Set false if domain_name's record is managed elsewhere (e.g. a different AWS account or DNS provider) — this module still provisions the LB/TLS/WAF, you just wire DNS yourself."
  type        = bool
  default     = true
}

variable "ssl_policy" {
  description = "ALB HTTPS listener security policy. Default requires TLS 1.2 minimum with TLS 1.3 available and drops legacy ciphers — the ingredient a scanner grades to get an A; do not downgrade to a policy that still permits TLS 1.0/1.1 or CBC ciphers without re-checking the scan."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "enable_deletion_protection" {
  description = "Whether the ALB rejects `terraform destroy`/console deletion until this is turned off first. Default false so dev/staging can be torn down freely; override true in prod.tfvars."
  type        = bool
  default     = false
}

variable "idle_timeout" {
  description = "Seconds an idle connection is kept open by the ALB before it closes it. Raise this above the default if apps/realtime's WebSocket upgrade route needs longer-lived idle connections once it's wired to this LB."
  type        = number
  default     = 60
}

variable "access_logs_bucket_id" {
  description = "S3 bucket to write ALB access logs to. null (default) disables access logging — no bucket for this exists yet in modules/storage (app-files and backups-archive serve different purposes) and this module doesn't create one unasked. Wire an existing bucket's ID here once ALB access-log analysis is actually needed."
  type        = string
  default     = null
}

variable "access_logs_prefix" {
  description = "Key prefix for ALB access logs within access_logs_bucket_id. Ignored if access_logs_bucket_id is null."
  type        = string
  default     = "alb"
}

variable "auth_rate_limit" {
  description = "Max requests per 5-minute rolling window, per source IP, WAF allows to any path starting with /auth before blocking that IP. AWS WAFv2 rate-based rules do not support a lower limit than 100."
  type        = number
  default     = 300

  validation {
    condition     = var.auth_rate_limit >= 100
    error_message = "auth_rate_limit must be >= 100 — AWS WAFv2's rate_based_statement rejects a lower limit."
  }
}

variable "schools_register_rate_limit" {
  description = "Max requests per 5-minute rolling window, per source IP, WAF allows to /schools/register before blocking that IP. Lower than auth_rate_limit by default: registration is a colder, more abuse-prone path than login/refresh traffic under /auth."
  type        = number
  default     = 100

  validation {
    condition     = var.schools_register_rate_limit >= 100
    error_message = "schools_register_rate_limit must be >= 100 — AWS WAFv2's rate_based_statement rejects a lower limit."
  }
}

variable "enable_waf_logging" {
  description = "Whether to ship WAF request logs (every rule match, including blocks) to CloudWatch Logs. Needed to actually verify the SQLi/XSS-block and rate-limit acceptance criteria after the fact, not just at test time."
  type        = bool
  default     = true
}

variable "waf_log_retention_days" {
  description = "CloudWatch Logs retention for WAF request logs. Matches modules/network's flow_log_retention_days default."
  type        = number
  default     = 90
}
