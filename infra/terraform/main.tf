module "naming" {
  source = "./modules/naming"

  project     = var.project
  environment = var.environment
  extra_tags  = var.extra_tags
}
