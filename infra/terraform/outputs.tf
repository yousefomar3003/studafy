output "environment" {
  description = "The environment this state was applied against."
  value       = var.environment
}

output "aws_region" {
  description = "The AWS region this environment is provisioned in."
  value       = var.aws_region
}

output "name_prefix" {
  description = "Canonical prefix every resource name in this environment starts with."
  value       = module.naming.name_prefix
}

output "tags" {
  description = "Canonical tag set applied to every resource via provider default_tags."
  value       = module.naming.tags
}

output "vpc_id" {
  description = "ID of this environment's VPC."
  value       = module.network.vpc_id
}

output "nat_gateway_public_ips" {
  description = "Elastic IPs the app tier's outbound traffic originates from — share with third-party providers that need IP allowlisting."
  value       = module.network.nat_gateway_public_ips
}

output "bastion_public_ip" {
  description = "Elastic IP of this environment's bastion."
  value       = module.network.bastion_public_ip
}

output "redis_replication_group_id" {
  description = "ElastiCache replication group ID — pass to `aws elasticache test-failover` for the dev failover drill (see modules/redis/README.md)."
  value       = module.redis.replication_group_id
}

output "redis_primary_endpoint_address" {
  description = "Redis write endpoint (host only). Combine with the AUTH token in redis_auth_secret_arn to connect."
  value       = module.redis.primary_endpoint_address
}

output "redis_reader_endpoint_address" {
  description = "Redis read-replica endpoint (host only)."
  value       = module.redis.reader_endpoint_address
}

output "redis_auth_secret_arn" {
  description = "Secrets Manager ARN holding the Redis AUTH token, endpoints, port and DB assignment. Grant secretsmanager:GetSecretValue to the roles that need it — the AUTH token itself is never a Terraform output."
  value       = module.redis.auth_secret_arn
}

output "storage_app_files_bucket_id" {
  description = "Name of the app-files bucket. Pass to `aws s3api`/`aws s3` commands when verifying lifecycle rules and CORS (see modules/storage/README.md)."
  value       = module.storage.app_files_bucket_id
}

output "storage_app_files_bucket_arn" {
  description = "ARN of the app-files bucket, for scoping the IAM policy on whatever role generates pre-signed URLs."
  value       = module.storage.app_files_bucket_arn
}

output "storage_app_files_bucket_regional_domain_name" {
  description = "Regional virtual-hosted-style domain of app-files, for constructing pre-signed URLs."
  value       = module.storage.app_files_bucket_regional_domain_name
}

output "storage_backups_archive_bucket_id" {
  description = "Name of the backups-archive bucket."
  value       = module.storage.backups_archive_bucket_id
}

output "storage_backups_archive_bucket_arn" {
  description = "ARN of the backups-archive bucket, for scoping the IAM policy on the backup job's role."
  value       = module.storage.backups_archive_bucket_arn
}

output "registry_repository_urls" {
  description = "Map of service name -> full ECR repository URL. See modules/registry/README.md and docs/runbooks/supply-chain-security.md."
  value       = module.registry.repository_urls
}

output "registry_ci_push_role_arn" {
  description = "IAM role CI assumes via GitHub OIDC to build, push and cosign-sign images."
  value       = module.registry.ci_push_role_arn
}

output "registry_deploy_pull_role_arn" {
  description = "IAM role a GitHub Actions run deploying to this environment assumes to pull and cosign-verify images."
  value       = module.registry.deploy_pull_role_arn
}

output "registry_signing_key_alias" {
  description = "KMS alias for the cosign signing key. Pass to cosign as awskms:///<this value>."
  value       = module.registry.signing_key_alias
}
