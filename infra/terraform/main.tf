data "terraform_remote_state" "bootstrap" {
  backend = "s3"

  config = {
    bucket = "studafy-tfstate-bootstrap-862910165270"
    key    = "bootstrap/terraform.tfstate"
    region = "eu-central-1"
  }
}

module "naming" {
  source = "./modules/naming"

  project     = var.project
  environment = var.environment
  extra_tags  = var.extra_tags
}

module "network" {
  source = "./modules/network"

  name_prefix               = module.naming.name_prefix
  vpc_cidr                  = var.vpc_cidr
  az_count                  = var.az_count
  single_nat_gateway        = var.single_nat_gateway
  db_port                   = var.db_port
  redis_port                = var.redis_port
  pgbouncer_port            = var.pgbouncer_port
  mariadb_port              = var.mariadb_port
  erpnext_port              = var.erpnext_port
  metrics_port              = var.metrics_port
  grafana_port              = var.grafana_port
  loki_port                 = var.loki_port
  otel_collector_port       = var.otel_collector_port
  bastion_allowed_ssh_cidrs = var.bastion_allowed_ssh_cidrs
  bastion_key_name          = var.bastion_key_name
}

module "redis" {
  source = "./modules/redis"

  name_prefix        = module.naming.name_prefix
  subnet_group_name  = module.network.elasticache_subnet_group_name
  security_group_ids = [module.network.redis_security_group_id]
  port               = var.redis_port
  node_type          = var.redis_node_type
}

module "postgres" {
  source = "./modules/postgres"

  name_prefix          = module.naming.name_prefix
  db_subnet_group_name = module.network.db_subnet_group_name
  security_group_ids   = [module.network.db_security_group_id]
  port                 = var.db_port
  instance_class       = var.postgres_instance_class
  deletion_protection  = var.postgres_deletion_protection
  skip_final_snapshot  = var.postgres_skip_final_snapshot
}

module "pgbouncer" {
  source = "./modules/pgbouncer"

  name_prefix                    = module.naming.name_prefix
  subnet_id                      = module.network.private_app_subnet_ids[0]
  security_group_ids             = [module.network.pgbouncer_security_group_id]
  postgres_connection_secret_arn = module.postgres.connection_secret_arn
  read_replica_host              = module.postgres.read_replica_address
  listen_port                    = var.pgbouncer_port
  instance_type                  = var.pgbouncer_instance_type
  key_name                       = var.pgbouncer_key_name

  # module.postgres.connection_secret_arn only forces module.postgres's secret *container* to
  # exist first, not its secret *version* — pgbouncer's instance reads the version's value at
  # boot. This module-level depends_on forces every postgres resource, including the secret
  # version, to finish before pgbouncer's instance is created.
  depends_on = [module.postgres]
}

locals {
  # module.mariadb/module.erpnext are staging/prod only (see their own count) — mirrors
  # module.cdn's existing count = var.environment == "dev" ? 0 : 1 precedent, dev doesn't need
  # the ERPNext plane.
  erpnext_plane_enabled = var.environment != "dev"

  # Prometheus/Grafana/the exporters (ST-259) — same reasoning and same condition as
  # erpnext_plane_enabled and module.monitoring's own probe_enabled: no separate environment to
  # page on for dev, and Container Insights/CloudWatch already cover its own needs.
  monitoring_enabled = var.environment != "dev"

  # Backup automation (ST-265): cross-region replication, the monthly locked vault, and every
  # EventBridge schedule are staging/prod only, same reasoning as monitoring_enabled — dev has no DR
  # requirement to exercise on a recurring, cost-bearing schedule. dev still gets module.backup's
  # Postgres restore-verify task definition itself (module.backup's own automation_enabled variable
  # only gates the recurring pieces, not the task definition), so
  # infra/deploy/scripts/postgres-restore-verify.sh can demonstrate PITR there by hand.
  backup_automation_enabled = var.environment != "dev"
  # Vector + Loki log-aggregation pipeline (ST-261) — same condition again: `aws logs tail` over
  # the per-service CloudWatch groups already covers a single-developer environment, and there is
  # no separate on-call to correlate a request across. staging/prod get the pipeline.
  logging_enabled = var.environment != "dev"
}

module "secrets" {
  source = "./modules/secrets"

  name_prefix = module.naming.name_prefix

  # api's runtime connects to Postgres through PgBouncer, not the master credential directly
  # (docs/runbooks/postgres-conventions.md's "Master credential" section); realtime's and
  # workers' entries match docs/runbooks/redis-conventions.md's DB-assignment table (workers =
  # queues, realtime = pub/sub, api = none yet) and module.pgbouncer's own service_pools (all
  # three services already get a connection budget there, ahead of the app code that will use it
  # — same "ready before the code catches up" precedent). erpnext's entry only exists where the
  # plane itself does (staging/prod) — its shared secrets are the ERPNext plane's own MariaDB and
  # its Redis cache/queue DB slots (docs/runbooks/redis-conventions.md).
  # monitoring's entry (ST-259) has no shared_secret_arns: unlike api/realtime/workers, it doesn't
  # read another module's connection secret — POSTGRES_EXPORTER_DSN/MYSQLD_EXPORTER_DSN/
  # GRAFANA_ADMIN_PASSWORD are pre-assembled DSN/password strings supplied directly via
  # TF_VAR_secrets_app_secret_values (infra/terraform/README.md's existing REDIS_URL/DATABASE_URL
  # convention), not composed from another module's own secret.
  services = merge(
    {
      api        = { shared_secret_arns = [module.pgbouncer.connection_secret_arn, module.redis.auth_secret_arn] }
      migrations = { shared_secret_arns = [module.postgres.connection_secret_arn] }
      realtime   = { shared_secret_arns = [module.redis.auth_secret_arn] }
      workers    = { shared_secret_arns = [module.redis.auth_secret_arn, module.pgbouncer.connection_secret_arn] }
    },
    local.erpnext_plane_enabled ? {
      erpnext = { shared_secret_arns = [module.mariadb[0].connection_secret_arn, module.redis.auth_secret_arn] }
    } : {},
    local.monitoring_enabled ? {
      monitoring = { shared_secret_arns = [] }
    } : {}
  )

  # erpnext's ADMIN_PASSWORD/ENCRYPTION_KEY are Terraform-generated (random_password below), not
  # externally supplied like the rest of secrets_app_secret_values — merged in here rather than
  # asked of the caller, since module.secrets is the one canonical place that owns
  # "${name_prefix}/erpnext/app-secrets" (see modules/erpnext/README.md's "What this module does
  # not do" for why modules/erpnext itself must not also create a secret at that same path).
  app_secret_values = merge(
    {
      realtime = {
        WS_JWT_SECRET = random_password.realtime_jwt.result
      }
    },
    var.secrets_app_secret_values,
    local.erpnext_plane_enabled ? {
      erpnext = {
        ADMIN_PASSWORD = random_password.erpnext_admin[0].result
        ENCRYPTION_KEY = random_password.erpnext_encryption_key[0].result
      }
    } : {}
  )

  postgres_connection_secret_arn = module.postgres.connection_secret_arn
  postgres_rotation_days         = var.postgres_rotation_days

  vpc_subnet_ids     = module.network.private_app_subnet_ids
  security_group_ids = [module.network.secrets_rotation_security_group_id]

  # module.postgres.connection_secret_arn only forces the secret *container* to exist first, not
  # its *version* — the rotation Lambda's first invocation reads the version. Same reasoning as
  # module.pgbouncer's own depends_on. module.redis and module.pgbouncer need no equivalent entry
  # here: their ARNs are only used as opaque strings in an IAM policy document above, which never
  # needs their secret *versions* to exist first.
  depends_on = [module.postgres]
}

resource "random_password" "realtime_jwt" {
  length  = 48
  special = false
}

# ERPNext's own generated secrets — not externally supplied (see module.secrets' app_secret_values
# above for why these are computed here rather than asked of the caller via
# secrets_app_secret_values). Ordinary random_password resources, same pattern modules/postgres
# and modules/mariadb already use for their own master credentials.
resource "random_password" "erpnext_admin" {
  count = local.erpnext_plane_enabled ? 1 : 0

  length  = 24
  special = true
}

resource "random_password" "erpnext_encryption_key" {
  count = local.erpnext_plane_enabled ? 1 : 0

  # Frappe's encryption_key is conventionally a bench-generated base64 Fernet-style key. This is
  # the closest Terraform can express on its own; swap for a bench-generated one before any
  # load-bearing data depends on it — see modules/erpnext/README.md's "Known gaps".
  length  = 32
  special = false
}

module "storage" {
  source = "./modules/storage"

  name_prefix = module.naming.name_prefix
  web_origin  = var.web_origin
}

module "registry" {
  source = "./modules/registry"

  name_prefix              = module.naming.name_prefix
  environment              = var.environment
  github_oidc_provider_arn = data.terraform_remote_state.bootstrap.outputs.github_oidc_provider_arn

  # The ECS task execution role is a third IAM principal (Fargate itself, pulling at task launch)
  # distinct from ci_push/deploy_pull — see modules/registry's additional_pull_role_arns and
  # infra/deploy/README.md's "Known gaps" #1.
  additional_pull_role_arns = [
    module.compute.execution_role_arn,
    module.compute.migrations_execution_role_arn,
  ]
}

module "dns" {
  source = "./modules/dns"

  aws_region = var.aws_region
  zone_id    = data.terraform_remote_state.bootstrap.outputs.route53_zone_id

  create_email_records = var.dns_create_email_records
  ses_domain           = var.dns_ses_domain
  mail_from_subdomain  = var.dns_mail_from_subdomain
  dmarc_policy         = var.dns_dmarc_policy
  dmarc_rua            = var.dns_dmarc_rua
  dmarc_ruf            = var.dns_dmarc_ruf
}

module "edge" {
  source = "./modules/edge"

  name_prefix                = module.naming.name_prefix
  public_subnet_ids          = module.network.public_subnet_ids
  alb_security_group_id      = module.network.alb_security_group_id
  domain_name                = var.edge_domain_name
  route53_zone_id            = data.terraform_remote_state.bootstrap.outputs.route53_zone_id
  create_dns_record          = var.edge_create_dns_record
  enable_deletion_protection = var.edge_enable_deletion_protection
  idle_timeout               = var.edge_idle_timeout
  pentest_allowed_cidrs      = var.edge_pentest_allowed_cidrs
}

# Not instantiated for dev: the ticket this module implements ("Provision CDN for web assets")
# scopes it to "staging/prod origins", and dev's web_origin is the local Vite dev server
# (http://localhost:5173) — nothing built to put behind a CDN there yet.
module "cdn" {
  source = "./modules/cdn"
  count  = var.environment == "dev" ? 0 : 1

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix                = module.naming.name_prefix
  environment                = var.environment
  domain_name                = var.cdn_domain_name
  route53_zone_id            = data.terraform_remote_state.bootstrap.outputs.route53_zone_id
  github_oidc_provider_arn   = data.terraform_remote_state.bootstrap.outputs.github_oidc_provider_arn
  enable_deletion_protection = var.cdn_enable_deletion_protection
}

# The ECS cluster, shared task-execution role, and api/realtime target groups + listener rules
# infra/deploy/README.md and infra/terraform/README.md both called out as the missing "future
# compute-tier module". Instantiated for every environment (dev included) — infra/deploy's own
# environments/dev.env already assumed this scope before this module existed to fill it.
module "compute" {
  source = "./modules/compute"

  name_prefix          = module.naming.name_prefix
  vpc_id               = module.network.vpc_id
  https_listener_arn   = module.edge.https_listener_arn
  app_files_bucket_arn = module.storage.app_files_bucket_arn

  secrets_service_iam_policy_arns = module.secrets.service_iam_policy_arns
}

module "monitoring" {
  source = "./modules/monitoring"

  name_prefix                       = module.naming.name_prefix
  aws_region                        = var.aws_region
  postgres_instance_id              = module.postgres.db_instance_id
  postgres_read_replica_instance_id = module.postgres.read_replica_instance_id
  mariadb_instance_id               = local.erpnext_plane_enabled ? module.mariadb[0].db_instance_id : null
  redis_replication_group_id        = module.redis.replication_group_id
  ecs_cluster_name                  = module.compute.cluster_name

  # Synthetic realtime probe (ST-149): staging/prod only — dev has no deployed realtime gateway
  # to probe, and the acceptance criteria explicitly scope the probe to staging/prod. It connects
  # through the public edge (wss://edge_domain_name/ws, the real client path), shares the app
  # security group whose Redis ingress already admits app-tier traffic, and reads WS_JWT_SECRET +
  # the Redis connection info from Secrets Manager.
  probe_enabled            = var.environment != "dev"
  realtime_ws_url          = "wss://${var.edge_domain_name}/ws"
  realtime_jwt_secret_arn  = module.secrets.service_secret_arns["realtime"]
  redis_auth_secret_arn    = module.redis.auth_secret_arn
  probe_subnet_ids         = module.network.private_app_subnet_ids
  probe_security_group_ids = [module.network.app_security_group_id]

  # Prometheus/Grafana metrics stack (ST-259): staging/prod only, same reasoning as probe_enabled
  # above — see local.monitoring_enabled. Reuses module.compute's shared execution role exactly
  # the way module.erpnext does (its secrets-read policy for the "monitoring" service key, from
  # the services map above, is attached to that role the same generic way every service's is).
  monitoring_enabled           = local.monitoring_enabled
  vpc_id                       = module.network.vpc_id
  cluster_arn                  = module.compute.cluster_arn
  execution_role_arn           = module.compute.execution_role_arn
  private_app_subnet_ids       = module.network.private_app_subnet_ids
  monitoring_security_group_id = module.network.monitoring_security_group_id
  metrics_port                 = var.metrics_port
  grafana_port                 = var.grafana_port
  mariadb_exporter_enabled     = local.erpnext_plane_enabled
  # Empty string, never used, when monitoring is disabled (dev) — service_secret_arns has no
  # "monitoring" key there, since local.monitoring_enabled gates that services map entry too.
  monitoring_secret_arn = lookup(module.secrets.service_secret_arns, "monitoring", "")
  prometheus_image      = "${module.registry.repository_urls["prometheus"]}:${var.prometheus_image_tag}"
  grafana_image         = "${module.registry.repository_urls["grafana"]}:${var.grafana_image_tag}"

  # Distributed tracing pipeline (ST-260): staging/prod only, riding on the same monitoring_enabled
  # flag as the metrics stack above rather than a second toggle — this ticket's own dependency on
  # ST-259 makes "monitoring plane exists" and "tracing pipeline exists" the same condition.
  otel_collector_port  = var.otel_collector_port
  otel_collector_image = "${module.registry.repository_urls["otel-collector"]}:${var.otel_collector_image_tag}"
  tempo_image          = "${module.registry.repository_urls["tempo"]}:${var.tempo_image_tag}"
}

# Vector + Loki log-aggregation pipeline (ST-261). staging/prod only — see local.logging_enabled.
# Gated at the call site (like module.cdn/mariadb/erpnext), not with an internal enable flag like
# module.monitoring: this module creates nothing that should exist in dev, so it is simply not
# instantiated there.
#
# Depends on module.compute (the ECS cluster + shared execution role the Vector/Loki Fargate
# services run on, and the api/realtime/workers CloudWatch log groups the pipeline subscribes to)
# and module.network (the VPC for the logging.internal Cloud Map namespace, the logging security
# group, and the bastion's own SSH audit log group — the security stream's first source).
module "logging" {
  source = "./modules/logging"
  count  = local.logging_enabled ? 1 : 0

  name_prefix               = module.naming.name_prefix
  aws_region                = var.aws_region
  environment               = var.environment
  vpc_id                    = module.network.vpc_id
  cluster_arn               = module.compute.cluster_arn
  execution_role_arn        = module.compute.execution_role_arn
  private_app_subnet_ids    = module.network.private_app_subnet_ids
  logging_security_group_id = module.network.logging_security_group_id
  loki_port                 = var.loki_port

  # api/realtime/workers/migrations — module.compute pre-creates these groups and the deploy.sh
  # task-definition templates log into them. The bastion's SSH audit log is the security stream:
  # every line is a security event, so it is force-mirrored to the write-once bucket.
  app_log_group_names      = values(module.compute.log_group_names)
  security_log_group_names = [module.network.bastion_ssh_log_group_name]

  # Same rolling-deploy shape as prometheus_image_tag/grafana_image_tag (ST-259): bump the tag and
  # re-apply to ship a vector.yaml or loki-config.yml.tpl change.
  vector_image = "${module.registry.repository_urls["vector"]}:${var.vector_image_tag}"
  loki_image   = "${module.registry.repository_urls["loki"]}:${var.loki_image_tag}"
}

# MariaDB for the ERPNext + Frappe Education plane. staging/prod only — see local.erpnext_plane_enabled.
module "mariadb" {
  source = "./modules/mariadb"
  count  = local.erpnext_plane_enabled ? 1 : 0

  name_prefix          = module.naming.name_prefix
  db_subnet_group_name = module.network.db_subnet_group_name
  security_group_ids   = [module.network.mariadb_security_group_id]
  port                 = var.mariadb_port
  instance_class       = var.mariadb_instance_class
  deletion_protection  = var.mariadb_deletion_protection
  skip_final_snapshot  = var.mariadb_skip_final_snapshot
}

# ERPNext + Frappe Education plane compute. staging/prod only. apps/api is this plane's sole
# caller (the "integration gateway") — enforced by module.network's erpnext security group, not by
# anything here. See modules/erpnext/README.md and docs/adr/0005-erpnext-education-plane.md.
module "erpnext" {
  source = "./modules/erpnext"
  count  = local.erpnext_plane_enabled ? 1 : 0

  name_prefix        = module.naming.name_prefix
  aws_region         = var.aws_region
  vpc_id             = module.network.vpc_id
  cluster_arn        = module.compute.cluster_arn
  execution_role_arn = module.compute.execution_role_arn

  private_app_subnet_ids = module.network.private_app_subnet_ids
  security_group_id      = module.network.erpnext_security_group_id
  frontend_port          = var.erpnext_port

  image_repository_url = module.registry.repository_urls["erpnext"]
  image_tag            = var.erpnext_image_tag

  mariadb_address                = module.mariadb[0].address
  mariadb_port                   = var.mariadb_port
  mariadb_connection_secret_arn  = module.mariadb[0].connection_secret_arn
  redis_primary_endpoint_address = module.redis.primary_endpoint_address
  redis_port                     = var.redis_port
  redis_auth_secret_arn          = module.redis.auth_secret_arn
  erpnext_secret_arn             = module.secrets.service_secret_arns["erpnext"]
}

# Backup automation and restore verification (ST-265): WAL-archiving-based continuous backup +
# cross-region copy (RDS-native, already true of module.postgres/module.mariadb's own
# backup_retention_period — see modules/backup/replication.tf), a monthly immutable snapshot
# (AWS Backup Vault Lock), and the weekly Postgres restore-verify / nightly ERPNext site-backup /
# monthly ERPNext restore-drill jobs. See infra/terraform/modules/backup/README.md and
# docs/architecture/SAD_30_backup_policy.md.
module "backup" {
  source = "./modules/backup"

  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  name_prefix           = module.naming.name_prefix
  aws_region            = var.aws_region
  automation_enabled    = local.backup_automation_enabled
  erpnext_plane_enabled = local.erpnext_plane_enabled
  dr_region             = var.backup_dr_region

  vpc_id                    = module.network.vpc_id
  private_app_subnet_ids    = module.network.private_app_subnet_ids
  backup_security_group_id  = module.network.backup_security_group_id
  erpnext_security_group_id = local.erpnext_plane_enabled ? module.network.erpnext_security_group_id : null

  cluster_arn        = module.compute.cluster_arn
  execution_role_arn = module.compute.execution_role_arn
  log_retention_days = 30

  postgres_db_instance_id        = module.postgres.db_instance_id
  postgres_address               = module.postgres.address
  postgres_port                  = var.db_port
  postgres_connection_secret_arn = module.postgres.connection_secret_arn
  postgres_db_subnet_group_name  = module.network.db_subnet_group_name
  postgres_db_security_group_id  = module.network.db_security_group_id
  postgres_backup_retention_days = module.postgres.backup_retention_days

  mariadb_db_instance_id        = local.erpnext_plane_enabled ? module.mariadb[0].db_instance_id : null
  mariadb_backup_retention_days = local.erpnext_plane_enabled ? module.mariadb[0].backup_retention_days : 7

  erpnext_image_repository_url           = local.erpnext_plane_enabled ? module.registry.repository_urls["erpnext"] : null
  erpnext_image_tag                      = var.erpnext_image_tag
  erpnext_efs_file_system_id             = local.erpnext_plane_enabled ? module.erpnext[0].efs_file_system_id : null
  erpnext_efs_access_point_id            = local.erpnext_plane_enabled ? module.erpnext[0].efs_access_point_id : null
  erpnext_mariadb_address                = local.erpnext_plane_enabled ? module.mariadb[0].address : null
  erpnext_mariadb_port                   = var.mariadb_port
  erpnext_mariadb_connection_secret_arn  = local.erpnext_plane_enabled ? module.mariadb[0].connection_secret_arn : null
  erpnext_redis_primary_endpoint_address = local.erpnext_plane_enabled ? module.redis.primary_endpoint_address : null
  erpnext_redis_port                     = var.redis_port
  erpnext_redis_auth_secret_arn          = local.erpnext_plane_enabled ? module.redis.auth_secret_arn : null
  erpnext_site_hostnames                 = var.erpnext_site_hostnames

  backups_archive_bucket_name = module.storage.backups_archive_bucket_id
  backups_archive_bucket_arn  = module.storage.backups_archive_bucket_arn

  backup_verify_image_repository_url = module.registry.repository_urls["backup-verify"]
  backup_verify_image_tag            = var.backup_verify_image_tag

  tenant_restore_operator_principal_arns = var.tenant_restore_operator_principal_arns
}
