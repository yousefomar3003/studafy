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

output "private_app_subnet_ids" {
  description = "Private app-tier subnet IDs, one per AZ. Closes infra/deploy/README.md's 'Known gaps' #3 — infra/deploy/scripts/populate-env.sh reads this to fill PRIVATE_APP_SUBNET_IDS."
  value       = module.network.private_app_subnet_ids
}

output "app_security_group_id" {
  description = "Security group ID for app-tier compute. Closes infra/deploy/README.md's 'Known gaps' #3 — infra/deploy/scripts/populate-env.sh reads this to fill APP_SECURITY_GROUP_ID."
  value       = module.network.app_security_group_id
}

output "erpnext_security_group_id" {
  description = "Security group ID for the ERPNext plane's ECS tasks. infra/deploy/scripts/erpnext-new-site.sh reads this for its run-task network configuration. Exists in every environment (module.network always creates it), even though the plane itself is staging/prod only."
  value       = module.network.erpnext_security_group_id
}

output "nat_gateway_public_ips" {
  description = "Elastic IPs the app tier's outbound traffic originates from — share with third-party providers that need IP allowlisting."
  value       = module.network.nat_gateway_public_ips
}

output "bastion_public_ip" {
  description = "Elastic IP of this environment's bastion."
  value       = module.network.bastion_public_ip
}

output "redis_replication_group_id" {
  description = "ElastiCache replication group ID — pass to `aws elasticache test-failover` for the dev failover drill (see modules/redis/README.md)."
  value       = module.redis.replication_group_id
}

output "redis_primary_endpoint_address" {
  description = "Redis write endpoint (host only). Combine with the AUTH token in redis_auth_secret_arn to connect."
  value       = module.redis.primary_endpoint_address
}

output "redis_reader_endpoint_address" {
  description = "Redis read-replica endpoint (host only)."
  value       = module.redis.reader_endpoint_address
}

output "redis_auth_secret_arn" {
  description = "Secrets Manager ARN holding the Redis AUTH token, endpoints, port and DB assignment. Grant secretsmanager:GetSecretValue to the roles that need it — the AUTH token itself is never a Terraform output."
  value       = module.redis.auth_secret_arn
}

output "postgres_db_instance_id" {
  description = "RDS instance identifier — pass to `aws rds reboot-db-instance --force-failover` for the dev failover drill (see modules/postgres/README.md)."
  value       = module.postgres.db_instance_id
}

output "postgres_address" {
  description = "Postgres write endpoint (host only). Combine with the credential in postgres_connection_secret_arn to connect."
  value       = module.postgres.address
}

output "postgres_connection_secret_arn" {
  description = "Secrets Manager ARN holding host, port, dbname, username, password and sslmode. Grant secretsmanager:GetSecretValue to the roles that need it — the password itself is never a Terraform output."
  value       = module.postgres.connection_secret_arn
}

output "pgbouncer_private_ip" {
  description = "Private IP of the PgBouncer host. Not sensitive by itself — combine with the credential in pgbouncer_connection_secret_arn to connect."
  value       = module.pgbouncer.private_ip
}

output "pgbouncer_port" {
  description = "TCP port PgBouncer (TLS-only) listens on. Same value as var.pgbouncer_port, echoed here for scripting against `terraform output`."
  value       = module.pgbouncer.port
}

output "pgbouncer_connection_secret_arn" {
  description = "Secrets Manager ARN holding PgBouncer's port, sslmode, CA certificate and stats-user credential as JSON (no host — see pgbouncer_private_ip). Grant secretsmanager:GetSecretValue to the api/workers/realtime roles that need it. Application connections still authenticate as the Postgres master user (see docs/runbooks/pgbouncer-conventions.md) — this secret's own credential is for the admin console only."
  value       = module.pgbouncer.connection_secret_arn
}

output "pgbouncer_log_group_name" {
  description = "CloudWatch Logs group PgBouncer's connection/disconnection/pool log is shipped to."
  value       = module.pgbouncer.log_group_name
}

output "secrets_service_secret_arns" {
  description = "Map of service name -> ARN of its own app-secrets container. See modules/secrets/README.md and docs/runbooks/secrets-conventions.md."
  value       = module.secrets.service_secret_arns
}

output "secrets_service_iam_policy_arns" {
  description = "Map of service name -> IAM managed policy ARN scoped to that service's own app-secrets container plus the shared data-tier secrets it needs. Attach to the service's compute task role once one exists."
  value       = module.secrets.service_iam_policy_arns
}

output "secrets_postgres_rotation_lambda_arn" {
  description = "ARN of the AWS-published RDS-Postgres rotation Lambda rotating module.postgres's master credential every postgres_rotation_days days."
  value       = module.secrets.postgres_rotation_lambda_arn
}

output "storage_app_files_bucket_id" {
  description = "Name of the app-files bucket. Pass to `aws s3api`/`aws s3` commands when verifying lifecycle rules and CORS (see modules/storage/README.md)."
  value       = module.storage.app_files_bucket_id
}

output "storage_app_files_bucket_arn" {
  description = "ARN of the app-files bucket, for scoping the IAM policy on whatever role generates pre-signed URLs."
  value       = module.storage.app_files_bucket_arn
}

output "storage_app_files_bucket_regional_domain_name" {
  description = "Regional virtual-hosted-style domain of app-files, for constructing pre-signed URLs."
  value       = module.storage.app_files_bucket_regional_domain_name
}

output "storage_backups_archive_bucket_id" {
  description = "Name of the backups-archive bucket."
  value       = module.storage.backups_archive_bucket_id
}

output "storage_backups_archive_bucket_arn" {
  description = "ARN of the backups-archive bucket, for scoping the IAM policy on the backup job's role."
  value       = module.storage.backups_archive_bucket_arn
}

output "registry_repository_urls" {
  description = "Map of service name -> full ECR repository URL. See modules/registry/README.md and docs/runbooks/supply-chain-security.md."
  value       = module.registry.repository_urls
}

output "registry_ci_push_role_arn" {
  description = "IAM role CI assumes via GitHub OIDC to build, push and cosign-sign images."
  value       = module.registry.ci_push_role_arn
}

output "registry_deploy_pull_role_arn" {
  description = "IAM role a GitHub Actions run deploying to this environment assumes to pull and cosign-verify images."
  value       = module.registry.deploy_pull_role_arn
}

output "registry_signing_key_alias" {
  description = "KMS alias for the cosign signing key. Pass to cosign as awskms:///<this value>."
  value       = module.registry.signing_key_alias
}

output "dns_zone_id" {
  description = "Route 53 hosted zone ID owned by the shared bootstrap stack. Pass to any future module that needs to add records into the same zone instead of doing its own data-source lookup."
  value       = module.dns.zone_id
}

output "dns_zone_name_servers" {
  description = "Authoritative name servers Route 53 assigned the shared hosted zone. Compare against the domain registrar's delegation — see modules/dns/README.md's import note."
  value       = data.terraform_remote_state.bootstrap.outputs.route53_name_servers
}

output "dns_ses_domain_identity_arn" {
  description = "ARN of the verified SES domain identity for dns_ses_domain. Grant ses:SendEmail/ses:SendRawEmail scoped to this ARN on whatever role ends up sending transactional mail. Null where dns_create_email_records is false."
  value       = module.dns.ses_domain_identity_arn
}

output "dns_ses_mail_from_domain" {
  description = "Custom MAIL FROM domain transactional email must be sent through for SPF alignment to hold. Null where dns_create_email_records is false."
  value       = module.dns.ses_mail_from_domain
}

output "edge_alb_dns_name" {
  description = "Default AWS DNS name of the load balancer — target for a TLS scan/testssl.sh run (see modules/edge/README.md)."
  value       = module.edge.alb_dns_name
}

output "edge_alb_arn" {
  description = "ARN of the load balancer."
  value       = module.edge.alb_arn
}

output "edge_domain_name" {
  description = "Public hostname the load balancer serves. Same value as var.edge_domain_name, echoed here for scripting against `terraform output`."
  value       = module.edge.domain_name
}

output "edge_https_listener_arn" {
  description = "ARN of the HTTPS listener. A future compute-tier module attaches target groups/listener rules here."
  value       = module.edge.https_listener_arn
}

output "edge_certificate_arn" {
  description = "ARN of the validated ACM certificate bound to the HTTPS listener."
  value       = module.edge.certificate_arn
}

output "edge_web_acl_arn" {
  description = "ARN of the WAFv2 web ACL in front of the load balancer."
  value       = module.edge.web_acl_arn
}

output "compute_migrations_execution_role_arn" {
  description = "Dedicated ECS execution role for the one-off database migration task."
  value       = module.compute.migrations_execution_role_arn
}

output "monitoring_dashboard_name" {
  description = "CloudWatch operations dashboard for RDS, Redis, and ECS."
  value       = module.monitoring.dashboard_name
}

output "monitoring_alarm_arns" {
  description = "Action-free operational alarms; notification actions are intentionally unset."
  value       = module.monitoring.alarm_arns
}

# module.cdn is not instantiated for dev (main.tf's count), so every output below is null there —
# one(...) rather than [0] indexing so `terraform output` doesn't error out on an empty list.
output "cdn_web_bundle_bucket_id" {
  description = "Name of the private web-bundle bucket. Deploy target for `aws s3 sync`. null in dev."
  value       = one(module.cdn[*].web_bundle_bucket_id)
}

output "cdn_distribution_id" {
  description = "CloudFront distribution ID. Pass to `aws cloudfront create-invalidation --distribution-id`. null in dev."
  value       = one(module.cdn[*].distribution_id)
}

output "cdn_distribution_domain_name" {
  description = "Default *.cloudfront.net domain CloudFront assigns the distribution. null in dev."
  value       = one(module.cdn[*].distribution_domain_name)
}

output "cdn_domain_name" {
  description = "Public hostname the CDN serves, same value as var.cdn_domain_name. null in dev."
  value       = one(module.cdn[*].domain_name)
}

output "cdn_deploy_role_arn" {
  description = "IAM role a GitHub Actions run deploying to this environment assumes to sync the web bundle and invalidate the CloudFront distribution. null in dev."
  value       = one(module.cdn[*].deploy_role_arn)
}

# --- Compute tier (modules/compute) — infra/deploy/scripts/populate-env.sh reads these ---------

output "compute_ecs_cluster_name" {
  description = "ECS cluster name. Pass as ECS_CLUSTER."
  value       = module.compute.cluster_name
}

output "compute_ecs_execution_role_arn" {
  description = "Shared ECS task execution role ARN. Pass as ECS_EXECUTION_ROLE_ARN."
  value       = module.compute.execution_role_arn
}

output "compute_api_target_group_arn" {
  description = "ALB target group ARN for apps/api. Pass as API_TARGET_GROUP_ARN."
  value       = module.compute.api_target_group_arn
}

output "compute_realtime_target_group_arn" {
  description = "ALB target group ARN for apps/realtime. Pass as REALTIME_TARGET_GROUP_ARN."
  value       = module.compute.realtime_target_group_arn
}

# --- ERPNext plane (modules/mariadb, modules/erpnext) — null in dev (see local.erpnext_plane_enabled) ---

output "mariadb_address" {
  description = "MariaDB write endpoint (host only). null in dev."
  value       = one(module.mariadb[*].address)
}

output "mariadb_connection_secret_arn" {
  description = "Secrets Manager ARN holding MariaDB's host/port/username/password/tls. null in dev."
  value       = one(module.mariadb[*].connection_secret_arn)
}

output "erpnext_internal_alb_dns_name" {
  description = "AWS-assigned DNS name of the ERPNext plane's internal ALB — apps/api's only path in. Automatically resolvable in-VPC, no Route 53 record. null in dev."
  value       = one(module.erpnext[*].internal_alb_dns_name)
}

output "erpnext_site_setup_task_definition_arn" {
  description = "ARN of the inert site-setup task definition. Pass to infra/deploy/scripts/erpnext-new-site.sh. null in dev."
  value       = one(module.erpnext[*].site_setup_task_definition_arn)
}

output "erpnext_cluster_service_names" {
  description = "Map of role -> ECS service name for the five long-running ERPNext services, for `aws ecs describe-services` health checks (docs/runbooks/environment-matrix.md's verification steps). Empty map in dev."
  value       = one(module.erpnext[*].cluster_service_names) == null ? {} : one(module.erpnext[*].cluster_service_names)
}
