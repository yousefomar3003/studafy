output "db_instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.id
}

output "address" {
  description = "MariaDB write endpoint (host only). Combine with the credential in connection_secret_arn to connect."
  value       = aws_db_instance.this.address
}

output "connection_secret_arn" {
  description = "Secrets Manager ARN holding host, port, username, password and tls. Grant secretsmanager:GetSecretValue to modules/erpnext's execution role — the password itself is never a Terraform output."
  value       = aws_secretsmanager_secret.mariadb.arn
}

output "backup_retention_days" {
  description = "Echoes var.backup_retention_days — the single source of truth modules/backup's cross-region replication (ST-265) reads, so its replica's retention can never exceed what the source itself actually keeps."
  value       = var.backup_retention_days
}
