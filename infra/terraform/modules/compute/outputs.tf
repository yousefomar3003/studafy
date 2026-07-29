output "cluster_name" {
  description = "ECS cluster name. Pass as ECS_CLUSTER in infra/deploy/environments/<env>.env — see infra/deploy/scripts/populate-env.sh."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "execution_role_arn" {
  description = "Shared ECS task execution role ARN. Pass as ECS_EXECUTION_ROLE_ARN, and add to modules/registry's additional_pull_role_arns so Fargate can actually pull images."
  value       = aws_iam_role.execution.arn
}

output "api_task_role_arn" {
  description = "API ECS task role with attachment access and reports/* read access."
  value       = aws_iam_role.api_task.arn
}

output "workers_task_role_arn" {
  description = "Workers ECS task role with reports/* upload-only access."
  value       = aws_iam_role.workers_task.arn
}

output "migrations_execution_role_arn" {
  description = "Dedicated ECS execution role limited to the migration image and PostgreSQL secret."
  value       = aws_iam_role.migrations_execution.arn
}

output "api_target_group_arn" {
  description = "ALB target group ARN for apps/api. Pass as API_TARGET_GROUP_ARN."
  value       = aws_lb_target_group.api.arn
}

output "realtime_target_group_arn" {
  description = "ALB target group ARN for apps/realtime. Pass as REALTIME_TARGET_GROUP_ARN."
  value       = aws_lb_target_group.realtime.arn
}

output "log_group_names" {
  description = "Map of service name -> CloudWatch Logs group name (api/realtime/workers/migrations)."
  value       = { for k, lg in aws_cloudwatch_log_group.service : k => lg.name }
}
