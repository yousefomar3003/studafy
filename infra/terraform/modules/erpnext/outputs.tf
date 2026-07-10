output "internal_alb_dns_name" {
  description = "AWS-assigned DNS name of the internal ALB (e.g. \"internal-studafy-staging-erpnext-123.eu-central-1.elb.amazonaws.com\") — resolvable automatically from anything in the VPC, no Route 53 record needed. This is what apps/api calls; wire it into apps/api's own config (ERPNEXT_BASE_URL or equivalent) once that application code exists."
  value       = aws_lb.internal.dns_name
}

output "site_setup_task_definition_arn" {
  description = "ARN of the inert (no aws_ecs_service) site-setup task definition, for infra/deploy/scripts/erpnext-new-site.sh's `aws ecs run-task --task-definition`."
  value       = aws_ecs_task_definition.site_setup.arn
}

output "efs_file_system_id" {
  description = "EFS filesystem ID holding the shared Frappe `sites` directory."
  value       = aws_efs_file_system.sites.id
}

output "cluster_service_names" {
  description = "Names of the five long-running ECS services (backend/websocket/queue/scheduler/frontend), for `aws ecs describe-services` health checks."
  value       = merge({ for k, s in aws_ecs_service.bench : k => s.name }, { frontend = aws_ecs_service.frontend.name })
}
