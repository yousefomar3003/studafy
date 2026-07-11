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
  services = merge(
    {
      api        = { shared_secret_arns = [module.pgbouncer.connection_secret_arn] }
      migrations = { shared_secret_arns = [module.postgres.connection_secret_arn] }
      realtime   = { shared_secret_arns = [module.redis.auth_secret_arn] }
      workers    = { shared_secret_arns = [module.redis.auth_secret_arn, module.pgbouncer.connection_secret_arn] }
    },
    local.erpnext_plane_enabled ? {
      erpnext = { shared_secret_arns = [module.mariadb[0].connection_secret_arn, module.redis.auth_secret_arn] }
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

  name_prefix        = module.naming.name_prefix
  vpc_id             = module.network.vpc_id
  https_listener_arn = module.edge.https_listener_arn

  secrets_service_iam_policy_arns = module.secrets.service_iam_policy_arns
}

module "monitoring" {
  source = "./modules/monitoring"

  name_prefix                = module.naming.name_prefix
  aws_region                 = var.aws_region
  postgres_instance_id       = module.postgres.db_instance_id
  mariadb_instance_id        = local.erpnext_plane_enabled ? module.mariadb[0].db_instance_id : null
  redis_replication_group_id = module.redis.replication_group_id
  ecs_cluster_name           = module.compute.cluster_name
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
