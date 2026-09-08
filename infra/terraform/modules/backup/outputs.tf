output "postgres_restore_verify_task_definition_arn" {
  description = "ARN of the inert Postgres restore-verify task definition. Pass to infra/deploy/scripts/postgres-restore-verify.sh, or to the weekly schedule (created automatically when automation_enabled)."
  value       = aws_ecs_task_definition.postgres_restore_verify.arn
}

output "postgres_restore_verify_task_role_arn" {
  description = "Task role the restore-verify container runs as — grant nothing further to it; it already has exactly what restore/delete/verify/report-upload needs."
  value       = aws_iam_role.postgres_restore_verify_task.arn
}

output "postgres_restore_verify_log_group_name" {
  description = "CloudWatch Logs group the restore-verify task's stdout/stderr is shipped to."
  value       = aws_cloudwatch_log_group.postgres_restore_verify.name
}

output "monthly_locked_vault_name" {
  description = "Name of the AWS Backup vault holding the monthly immutable (Vault Lock, Compliance mode) Postgres + MariaDB snapshots. null when automation_enabled is false."
  value       = one(aws_backup_vault.monthly[*].name)
}

output "monthly_locked_vault_arn" {
  description = "ARN of the locked vault. null when automation_enabled is false."
  value       = one(aws_backup_vault.monthly[*].arn)
}

output "erpnext_site_backup_task_definition_arn" {
  description = "ARN of the ERPNext nightly site+database backup task definition. null in dev / when erpnext_plane_enabled is false."
  value       = one(aws_ecs_task_definition.erpnext_site_backup[*].arn)
}

output "erpnext_restore_drill_task_definition_arn" {
  description = "ARN of the ERPNext monthly restore-drill task definition. Pass to infra/deploy/scripts/erpnext-restore-drill.sh for an on-demand run. null in dev / when erpnext_plane_enabled is false."
  value       = one(aws_ecs_task_definition.erpnext_restore_drill[*].arn)
}

output "dr_kms_key_arn" {
  description = "ARN (in var.dr_region) of the KMS key encrypting cross-region replicated automated backups."
  value       = aws_kms_key.dr_backup.arn
}
