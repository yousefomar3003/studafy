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

module "storage" {
  source = "./modules/storage"

  name_prefix = module.naming.name_prefix
  web_origin  = var.web_origin
}

module "registry" {
  source = "./modules/registry"

  name_prefix = module.naming.name_prefix
  environment = var.environment
}

module "edge" {
  source = "./modules/edge"

  name_prefix                = module.naming.name_prefix
  public_subnet_ids          = module.network.public_subnet_ids
  alb_security_group_id      = module.network.alb_security_group_id
  domain_name                = var.edge_domain_name
  route53_zone_name          = var.route53_zone_name
  create_dns_record          = var.edge_create_dns_record
  enable_deletion_protection = var.edge_enable_deletion_protection
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
  route53_zone_name          = var.route53_zone_name
  github_oidc_provider_arn   = module.registry.github_oidc_provider_arn
  enable_deletion_protection = var.cdn_enable_deletion_protection
}
