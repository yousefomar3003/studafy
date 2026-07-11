variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "environment" {
  description = <<-EOT
    Terraform environment (dev | staging | prod), matching the root module's var.environment.
    Used only to scope the deploy_pull role's trust condition to the same-named GitHub
    Environment (repo:<github_repository>:environment:<environment>) — not validated against the
    root's dev|staging|prod list here to avoid two sources of truth for that check; an invalid
    value simply produces a trust condition that no workflow run can ever satisfy.
  EOT
  type        = string
}

variable "github_repository" {
  description = <<-EOT
    "<owner>/<repo>" GitHub slug allowed to assume ci_push (any ref) and deploy_pull (scoped to
    the matching GitHub Environment) via OIDC. Defaults to this repo's own origin remote — override
    only if the registry is ever provisioned from a fork or a different CI repository.
  EOT
  type        = string
  default     = "yousefomar3003/studafy"
}

variable "github_oidc_provider_arn" {
  description = "Account-wide GitHub Actions OIDC provider ARN owned by the bootstrap stack."
  type        = string
}

variable "image_repository_names" {
  description = <<-EOT
    One ECR repository is created per name in this list, as "<name_prefix>/<name>". Defaults to
    the three long-running services ADR-004 already commits to a container shape for (apps/api,
    apps/realtime, apps/workers). apps/mobile is a native app, not containerized, so it's not in
    the default. apps/web has a Dockerfile (infra/docker/web.Dockerfile) but is deliberately still
    not in the default either — it also has an existing CDN-hosted static-bundle path
    (modules/cdn), and which of the two deployment shapes ships hasn't been decided; see
    infra/docker/README.md's "Known gaps". A list, not hardcoded locals like modules/storage's two
    buckets, because unlike that fixed pair, the set of containerized services is expected to grow
    as new ones are scaffolded.
  EOT
  type        = list(string)
  default     = ["api", "realtime", "workers", "web", "erpnext"]

  validation {
    condition     = length(var.image_repository_names) > 0
    error_message = "image_repository_names must not be empty."
  }

  validation {
    condition     = alltrue([for n in var.image_repository_names : can(regex("^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$", n))])
    error_message = "each image_repository_names entry must be a valid ECR repository path segment (lowercase alphanumeric, '.', '_', '-')."
  }
}

variable "additional_pull_role_arns" {
  description = <<-EOT
    Extra IAM role ARNs exempted from the DenyPullExceptCiPushAndDeployPull repository policy
    statement (repository_policy.tf), alongside ci_push and deploy_pull. Exists for one reason:
    the ECS task *execution* role (modules/compute) is a third, distinct IAM principal — it pulls
    images at task launch on Fargate's behalf, and is neither ci_push (build-time) nor deploy_pull
    (CI's own deploy-time identity) — so without this, every task launch would be denied by this
    module's own least-privilege policy. See infra/deploy/README.md's "Known gaps" #1. Empty by
    default so this module has no opinion on a compute tier that may not exist yet in every caller.
  EOT
  type        = list(string)
  default     = []
}

variable "untagged_image_expiration_days" {
  description = "Days an untagged image is kept before the lifecycle policy expires it. Untagged images accumulate from IMMUTABLE's rejection of tag overwrites, not from normal use, so this is cleanup, not a retention policy for anything meant to be pulled by tag."
  type        = number
  default     = 14

  validation {
    condition     = var.untagged_image_expiration_days >= 1
    error_message = "untagged_image_expiration_days must be at least 1."
  }
}

variable "signing_key_deletion_window_days" {
  description = "Waiting period before the cosign signing KMS key is actually deleted after a `terraform destroy` or removal from config. KMS enforces 7-30; 30 (the maximum) is the default so an accidental destroy leaves the longest possible window to recover a key that every already-signed image's signature depends on."
  type        = number
  default     = 30

  validation {
    condition     = var.signing_key_deletion_window_days >= 7 && var.signing_key_deletion_window_days <= 30
    error_message = "signing_key_deletion_window_days must be between 7 and 30 (KMS's allowed range)."
  }
}
