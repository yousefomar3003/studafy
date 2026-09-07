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
    # The probe alarm is conditional (probe_enabled); a null element drops it from the list.
    compact([for alarm in aws_cloudwatch_metric_alarm.realtime_probe_latency : alarm.arn]),
  )
}

output "realtime_probe_function_name" {
  description = "Name of the synthetic realtime probe Lambda, or null when the probe is disabled."
  value       = var.probe_enabled ? aws_lambda_function.realtime_probe[0].function_name : null
}

output "deploys_log_group_name" {
  description = "CloudWatch Logs group the staging deploy pipeline writes one line per outcome to; rendered as the dashboard's 'Recent deploys' widget."
  value       = aws_cloudwatch_log_group.deploys.name
}

# --- Prometheus/Grafana metrics stack (ST-259) ---------------------------------------------------

output "metrics_discovery_service_arns" {
  description = "Map of {api, realtime, workers} -> Cloud Map aws_service_discovery_service ARN. infra/deploy/scripts/populate-env.sh reads these into infra/deploy/environments/<env>.env, and each service's own service.json.tpl registers into them via serviceRegistries — see discovery.tf for why api/realtime/workers, deploy.sh-owned rather than Terraform-owned, still get their registration target created here."
  value = {
    for name in ["api", "realtime", "workers"] :
    name => aws_service_discovery_service.this[name].arn
  }
}

output "grafana_access_hint" {
  description = "Reminder of how to reach Grafana: it has no public endpoint (module.network's monitoring security group admits only the bastion). See docs/runbooks/metrics-dashboard-catalog.md for the full access instructions."
  value       = "ssh -L 3000:grafana.metrics.internal:${var.grafana_port} <bastion>  # then open http://localhost:3000"
}
