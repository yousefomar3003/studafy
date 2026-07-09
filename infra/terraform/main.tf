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
  bastion_allowed_ssh_cidrs = var.bastion_allowed_ssh_cidrs
  bastion_key_name          = var.bastion_key_name
}
