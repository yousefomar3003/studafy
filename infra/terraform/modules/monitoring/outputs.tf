output "dashboard_name" {
  description = "CloudWatch operations dashboard name."
  value       = aws_cloudwatch_dashboard.operations.dashboard_name
}

output "alarm_arns" {
  description = "All action-free alarm ARNs, ready for notification actions after ownership is agreed."
  value = concat(
    [for alarm in aws_cloudwatch_metric_alarm.rds_cpu : alarm.arn],
    [
      aws_cloudwatch_metric_alarm.postgres_storage.arn,
      aws_cloudwatch_metric_alarm.postgres_replica_lag.arn,
      aws_cloudwatch_metric_alarm.redis_cpu.arn,
    ],
    [for alarm in aws_cloudwatch_metric_alarm.ecs_cpu : alarm.arn],
  )
}
