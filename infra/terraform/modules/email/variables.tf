variable "enabled" {
  description = "Create the email delivery resources. True only where modules/dns verifies a sending domain."
  type        = bool
}

variable "name_prefix" {
  description = "Environment name prefix (module.naming)."
  type        = string
}

variable "ses_domain" {
  description = "The SES-verified sending domain, e.g. send.studafy.com. The workers may send only from addresses on it."
  type        = string
  default     = ""
}

variable "ses_identity_arn" {
  description = "ARN of the SES domain identity (module.dns output). Required when enabled."
  type        = string
  default     = null
}

variable "webhook_url" {
  description = "The API's public SNS webhook, https://<api host>/email/webhooks/sns."
  type        = string
  default     = ""
}

variable "workers_task_role_id" {
  description = "The workers ECS task role (module.compute) that sends email."
  type        = string
}
