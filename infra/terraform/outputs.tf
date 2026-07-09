output "environment" {
  description = "The environment this state was applied against."
  value       = var.environment
}

output "aws_region" {
  description = "The AWS region this environment is provisioned in."
  value       = var.aws_region
}

output "name_prefix" {
  description = "Canonical prefix every resource name in this environment starts with."
  value       = module.naming.name_prefix
}

output "tags" {
  description = "Canonical tag set applied to every resource via provider default_tags."
  value       = module.naming.tags
}
