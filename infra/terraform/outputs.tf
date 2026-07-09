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

output "vpc_id" {
  description = "ID of this environment's VPC."
  value       = module.network.vpc_id
}

output "nat_gateway_public_ips" {
  description = "Elastic IPs the app tier's outbound traffic originates from — share with third-party providers that need IP allowlisting."
  value       = module.network.nat_gateway_public_ips
}

output "bastion_public_ip" {
  description = "Elastic IP of this environment's bastion."
  value       = module.network.bastion_public_ip
}
