variable "aws_account_id" {
  description = "AWS account that owns Studafy's shared bootstrap resources."
  type        = string
  default     = "862910165270"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Home region for state and IAM-adjacent bootstrap resources."
  type        = string
  default     = "eu-central-1"
}

variable "domain_name" {
  description = "Public apex migrated from registrar DNS to Route 53."
  type        = string
  default     = "studafy.com"
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to use bootstrap OIDC roles."
  type        = string
  default     = "yousefomar3003/studafy"
}

variable "google_site_verification" {
  description = "Existing Google site-verification TXT value that must survive DNS migration."
  type        = string
  default     = "google-site-verification=obtG1YxjdpJOUNqxaLztOek__P7zpNuWtHJabFE-G1s"
}
