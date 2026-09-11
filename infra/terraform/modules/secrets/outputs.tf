output "service_secret_arns" {
  description = "Map of service name -> ARN of its own app-secrets container (\"$${name_prefix}/<service>/app-secrets\"). Grant read access via service_iam_policy_arns rather than a fresh policy document."
  value       = { for k, v in aws_secretsmanager_secret.app : k => v.arn }
}

output "service_iam_policy_arns" {
  description = "Map of service name -> ARN of a managed IAM policy scoped to secretsmanager:GetSecretValue on exactly that service's own app-secrets container plus its declared shared_secret_arns. Attach via aws_iam_role_policy_attachment once a compute task role exists for that service."
  value       = { for k, v in aws_iam_policy.service_secrets : k => v.arn }
}

output "service_names" {
  description = "Set of service_iam_policy_arns's keys, computed from var.services (a plain variable) rather than from aws_iam_policy.service_secrets (a resource) — a caller for_each-ing over service_iam_policy_arns's keys directly hits Terraform's 'known only after apply' limitation for a map built from a resource's own attributes; this output stays statically known across the module boundary instead. See module.compute's secrets_service_names for the consumer."
  value       = toset(keys(var.services))
}

output "postgres_rotation_lambda_arn" {
  description = "ARN of the AWS-published RDS-Postgres single-user rotation Lambda (deployed via the Serverless Application Repository), wired to rotate module.postgres's master credential every postgres_rotation_days days."
  value       = aws_serverlessapplicationrepository_cloudformation_stack.postgres_rotation.outputs["RotationLambdaARN"]
}

output "postgres_rotation_enabled" {
  description = "Whether AWS reports automatic rotation as enabled on the secret at postgres_connection_secret_arn."
  value       = aws_secretsmanager_secret_rotation.postgres.rotation_enabled
}
