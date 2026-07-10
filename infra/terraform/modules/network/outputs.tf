output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "IPv4 CIDR of the VPC."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs (ALB, NAT gateways, bastion), one per AZ."
  value       = aws_subnet.public[*].id
}

output "private_app_subnet_ids" {
  description = "Private app-tier subnet IDs, one per AZ. Routed outbound through NAT."
  value       = aws_subnet.private_app[*].id
}

output "private_data_subnet_ids" {
  description = "Private data-tier subnet IDs (DB/Redis), one per AZ. No route to the internet."
  value       = aws_subnet.private_data[*].id
}

output "db_subnet_group_name" {
  description = "Name of the aws_db_subnet_group spanning the private-data subnets, for a future RDS module."
  value       = aws_db_subnet_group.this.name
}

output "elasticache_subnet_group_name" {
  description = "Name of the aws_elasticache_subnet_group spanning the private-data subnets, for a future ElastiCache module."
  value       = aws_elasticache_subnet_group.this.name
}

output "nat_gateway_public_ips" {
  description = "Elastic IPs of the NAT gateway(s) — the app tier's outbound traffic always originates from one of these, so third-party providers can allowlist them."
  value       = aws_eip.nat[*].public_ip
}

output "alb_security_group_id" {
  description = "Security group ID to attach to the load balancer."
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group ID to attach to app-tier compute (behind the ALB)."
  value       = aws_security_group.app.id
}

output "db_security_group_id" {
  description = "Security group ID to attach to the database."
  value       = aws_security_group.db.id
}

output "redis_security_group_id" {
  description = "Security group ID to attach to Redis."
  value       = aws_security_group.redis.id
}

output "pgbouncer_security_group_id" {
  description = "Security group ID to attach to PgBouncer's compute."
  value       = aws_security_group.pgbouncer.id
}

output "secrets_rotation_security_group_id" {
  description = "Security group ID to attach to the Secrets Manager RDS rotation Lambda (modules/secrets)."
  value       = aws_security_group.secrets_rotation.id
}

output "mariadb_security_group_id" {
  description = "Security group ID to attach to the ERPNext plane's MariaDB instance (modules/mariadb)."
  value       = aws_security_group.mariadb.id
}

output "erpnext_security_group_id" {
  description = "Security group ID to attach to the ERPNext plane's ECS tasks and EFS mount targets (modules/erpnext). Ingress is scoped to the app tier only — apps/api is the integration gateway."
  value       = aws_security_group.erpnext.id
}

output "bastion_security_group_id" {
  description = "Security group ID of the bastion."
  value       = aws_security_group.bastion.id
}

output "bastion_instance_id" {
  description = "Instance ID of the bastion."
  value       = aws_instance.bastion.id
}

output "bastion_public_ip" {
  description = "Elastic IP of the bastion."
  value       = aws_eip.bastion.public_ip
}

output "bastion_ssh_log_group_name" {
  description = "CloudWatch Logs group the bastion's SSH audit log is shipped to."
  value       = aws_cloudwatch_log_group.bastion_ssh.name
}
