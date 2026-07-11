provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "studafy"
      ManagedBy = "terraform"
      Scope     = "bootstrap"
    }
  }
}
