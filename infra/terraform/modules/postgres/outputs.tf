output "db_instance_id" {
  description = "RDS instance identifier. Use it to run the failover drill: aws rds reboot-db-instance --db-instance-identifier <this> --force-failover."
  value       = aws_db_instance.this.identifier
}

output "address" {
  description = "Write endpoint (host only, no port). Not sensitive by itself — combine with the credential in connection_secret_arn to connect."
  value       = aws_db_instance.this.address
}

output "read_replica_instance_id" {
  description = "RDS read-replica identifier used for reporting health and lag alarms, or null when backup_retention_days is 0 and no replica exists (see main.tf's read_replica count) — a caller building a replica-lag alarm should skip it entirely when this is null rather than alarm on the primary under a misleading name."
  value       = try(aws_db_instance.read_replica[0].identifier, null)
}

output "read_replica_address" {
  description = "Read-replica endpoint (host only) when one exists; falls back to the primary's own address when backup_retention_days is 0 (see main.tf's read_replica count) so module.pgbouncer's read pools always get a real, live endpoint to route to — reads just aren't offloaded from the primary in that case, the same outcome as deliberately choosing zero replicas."
  value       = try(aws_db_instance.read_replica[0].address, aws_db_instance.this.address)
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

output "backup_retention_days" {
  description = "Echoes var.backup_retention_days — the single source of truth for how long RDS's own continuous backup exists, which modules/backup's cross-region replication (ST-265) must never exceed (a replica can't outlive backups the source has already expired)."
  value       = var.backup_retention_days
}
