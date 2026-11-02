output "replication_group_id" {
  description = "ElastiCache replication group ID. Use it to run the failover drill: aws elasticache test-failover --replication-group-id <this> --node-group-id 0001."
  value       = aws_elasticache_replication_group.this.replication_group_id
}

output "primary_endpoint_address" {
  description = "Write endpoint (host only). Not sensitive by itself — combine with the AUTH token from auth_secret_arn to connect."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Read-replica endpoint (host only)."
  value       = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "port" {
  description = "TCP port Redis (TLS-only) listens on."
  value       = var.port
}

output "auth_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the AUTH token, endpoints, port and DB assignment as JSON. Grant secretsmanager:GetSecretValue to the api/workers/realtime IAM roles that need it — the AUTH token is never exposed via a Terraform output."
  value       = aws_secretsmanager_secret.redis.arn
}

output "cache_db_index" {
  description = "Logical DB index for cache traffic (SELECT 0). Namespace isolation only, not an eviction boundary — see docs/runbooks/redis-conventions.md."
  value       = local.cache_db_index
}

output "queue_db_index" {
  description = "Logical DB index for BullMQ queue traffic (SELECT 1)."
  value       = local.queue_db_index
}
