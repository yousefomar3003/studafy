output "dashboard_name" {
  description = "CloudWatch operations dashboard name."
  value       = aws_cloudwatch_dashboard.operations.dashboard_name
}

output "alarm_arns" {
  description = "Every CloudWatch alarm ARN this module creates, both regions. They notify through module.alert_topic into Alertmanager wherever monitoring_enabled is true, and notify nobody in dev — see alerts.tf's local.alarm_actions."
  value = concat(
    [for alarm in aws_cloudwatch_metric_alarm.this : alarm.arn],
    [for alarm in aws_cloudwatch_metric_alarm.us_east_1 : alarm.arn],
  )
}

output "alert_topic_arn" {
  description = "SNS topic every in-region CloudWatch alarm publishes to, bridged into Alertmanager. Null in dev. Exposed so a future alarm defined outside this module has one documented way to reach the same on-call rotation rather than inventing a second notification path."
  value       = var.monitoring_enabled ? module.alert_topic[0].topic_arn : null
}

output "alert_bridge_function_name" {
  description = "Name of the CloudWatch alarm -> Alertmanager bridge Lambda, or null when the monitoring plane is disabled. Its log group is where an undelivered alarm notification is diagnosed."
  value       = var.monitoring_enabled ? aws_lambda_function.alert_bridge[0].function_name : null
}

output "realtime_probe_function_name" {
  description = "Name of the synthetic realtime probe Lambda, or null when the probe is disabled."
  value       = var.probe_enabled ? aws_lambda_function.realtime_probe[0].function_name : null
}

output "deploys_log_group_name" {
  description = "CloudWatch Logs group the staging deploy pipeline writes one line per outcome to; rendered as the dashboard's 'Recent deploys' widget."
  value       = aws_cloudwatch_log_group.deploys.name
}

# --- Black-box synthetic availability probes (ST-263) --------------------------------------------

output "synthetics_probe_function_name" {
  description = "Name of the black-box synthetic probe Lambda — the same name in both var.aws_region and synthetics_dr_region, since Lambda function names are scoped per region — or null when synthetics are disabled."
  value       = var.synthetics_enabled ? aws_lambda_function.synthetics_probe[0].function_name : null
}

output "availability_slo_dashboard_name" {
  description = "CloudWatch dashboard name for the NFR-03 availability SLO (ST-263), or null when synthetics are disabled."
  value       = var.synthetics_enabled ? aws_cloudwatch_dashboard.availability_slo[0].dashboard_name : null
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
