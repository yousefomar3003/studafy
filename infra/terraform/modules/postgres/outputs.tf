output "db_instance_id" {
  description = "RDS instance identifier. Use it to run the failover drill: aws rds reboot-db-instance --db-instance-identifier <this> --force-failover."
  value       = aws_db_instance.this.identifier
}

output "address" {
  description = "Write endpoint (host only, no port). Not sensitive by itself — combine with the credential in connection_secret_arn to connect."
  value       = aws_db_instance.this.address
}

output "read_replica_instance_id" {
  description = "RDS read-replica identifier used for reporting health and lag alarms."
  value       = aws_db_instance.read_replica.identifier
}

output "read_replica_address" {
  description = "Read-replica endpoint (host only). Route reporting traffic through PgBouncer's read pools."
  value       = aws_db_instance.read_replica.address
}

output "port" {
  description = "TCP port Postgres (SSL-enforced) listens on."
  value       = var.port
}

output "database_name" {
  description = "Name of the initial database created on the instance."
  value       = var.database_name
}

output "connection_secret_arn" {
  description = "ARN of the Secrets Manager secret holding host, port, dbname, username, password and sslmode as JSON. Grant secretsmanager:GetSecretValue to the api/workers IAM roles that need it — the password is never exposed via a Terraform output."
  value       = aws_secretsmanager_secret.postgres.arn
}

output "parameter_group_name" {
  description = "Name of the aws_db_parameter_group applied to the instance."
  value       = aws_db_parameter_group.this.name
}
