output "instance_id" {
  description = "EC2 instance ID of the PgBouncer host."
  value       = aws_instance.this.id
}

output "private_ip" {
  description = "Private IP of the PgBouncer host (not sensitive by itself — combine with the credential in connection_secret_arn to connect)."
  value       = aws_instance.this.private_ip
}

output "port" {
  description = "TCP port PgBouncer (TLS-only) listens on."
  value       = var.listen_port
}

output "connection_secret_arn" {
  description = "ARN of the Secrets Manager secret holding port, sslmode, the CA certificate to verify against, and the stats-user credential as JSON (no host — see the private_ip output; keeping it out of this secret avoids a dependency cycle with the instance that reads this secret at boot). Grant secretsmanager:GetSecretValue to the api/workers/realtime IAM roles that need it. Application connections still authenticate as the Postgres master user via userlist.txt (no per-service Postgres role exists yet); this secret's own credential is for the admin console only."
  value       = aws_secretsmanager_secret.pgbouncer.arn
}

output "log_group_name" {
  description = "CloudWatch Logs group PgBouncer's connection/disconnection/pool log is shipped to."
  value       = aws_cloudwatch_log_group.pgbouncer.name
}

output "cloudwatch_metrics_namespace" {
  description = "CloudWatch custom-metric namespace pool-saturation metrics are published under (ClientsWaiting, ClientsActive, ServersActive, ServersIdle, ServersUsed, MaxWaitSeconds, dimensioned by Pool)."
  value       = var.cloudwatch_metrics_namespace
}
