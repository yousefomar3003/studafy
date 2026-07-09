provider "aws" {
  region = var.aws_region

  # Every resource created by this root module inherits the canonical tag set,
  # so individual resources never restate Project/Environment/ManagedBy.
  default_tags {
    tags = module.naming.tags
  }
}
