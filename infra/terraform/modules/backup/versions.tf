# Declared only for the aws.dr alias the caller must pass; the root module
# (infra/terraform/versions.tf) pins the provider version for the whole configuration.
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.dr]
    }
  }
}
