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
