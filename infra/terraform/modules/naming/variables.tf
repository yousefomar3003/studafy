variable "project" {
  description = "Project slug, e.g. \"studafy\"."
  type        = string
}

variable "environment" {
  description = "Environment short name: dev, staging or prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "extra_tags" {
  description = "Additional tags merged on top of (and able to override) the canonical set."
  type        = map(string)
  default     = {}
}
