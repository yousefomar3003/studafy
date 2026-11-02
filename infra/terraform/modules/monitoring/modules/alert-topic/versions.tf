# Declared because this module is instantiated twice under *different* providers — once with the
# default `aws`, once with the root's `aws.us_east_1` alias (see main.tf's header for why). Without
# an explicit `required_providers` entry, `terraform validate` warns that the `providers = { aws =
# aws.us_east_1 }` argument at the call site names a provider this module never declared, and the
# pass works only by inference.
#
# No version constraint and no `required_version`: the root module
# (infra/terraform/versions.tf) pins Terraform and every provider version for the whole
# configuration, and restating either here would be a second place to update.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}
