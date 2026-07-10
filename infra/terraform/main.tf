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

module "dns" {
  source = "./modules/dns"

  name_prefix = module.naming.name_prefix
  aws_region  = var.aws_region
  zone_name   = var.route53_zone_name

  manage_zone                = var.dns_manage_zone
  protect_apex_from_spoofing = var.dns_protect_apex_from_spoofing

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
  route53_zone_name          = var.route53_zone_name
  create_dns_record          = var.edge_create_dns_record
  enable_deletion_protection = var.edge_enable_deletion_protection
}
