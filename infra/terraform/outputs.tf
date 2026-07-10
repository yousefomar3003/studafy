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
