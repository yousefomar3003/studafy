output "repository_urls" {
  description = "Map of image_repository_names entry -> full ECR repository URL (registry/repo, no tag), e.g. { api = \"123456789012.dkr.ecr.eu-central-1.amazonaws.com/studafy-prod/api\" }. Use as the `docker build -t` / `docker push` target."
  value       = { for k, repo in aws_ecr_repository.this : k => repo.repository_url }
}

output "repository_arns" {
  description = "Map of image_repository_names entry -> repository ARN. Scope any additional IAM policy (outside ci_push/deploy_pull) to these, never to \"*\"."
  value       = { for k, repo in aws_ecr_repository.this : k => repo.arn }
}

output "ci_push_role_arn" {
  description = "IAM role CI assumes via GitHub OIDC to build, push and cosign-sign images. Pass to `aws-actions/configure-aws-credentials`'s `role-to-assume` in the CI push job — see docs/runbooks/supply-chain-security.md."
  value       = aws_iam_role.ci_push.arn
}

output "deploy_pull_role_arn" {
  description = "IAM role a GitHub Actions run deploying to the module's `environment` GitHub Environment assumes to pull and cosign-verify images. Assumable only from a workflow run tied to that named Environment."
  value       = aws_iam_role.deploy_pull.arn
}

output "signing_key_arn" {
  description = "ARN of the asymmetric KMS key cosign signs/verifies against. The private key material never leaves KMS and is never a Terraform output."
  value       = aws_kms_key.image_signing.arn
}

output "signing_key_alias" {
  description = "KMS alias for the signing key, e.g. \"alias/studafy-prod-image-signing\". Pass to cosign as `awskms:///<this value>` (see docs/runbooks/supply-chain-security.md for the full command)."
  value       = aws_kms_alias.image_signing.name
}

output "github_oidc_provider_arn" {
  description = "Account-wide bootstrap OIDC provider ARN consumed by this module."
  value       = var.github_oidc_provider_arn
}
