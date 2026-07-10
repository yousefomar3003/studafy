terraform {
  # No provider block: modules never configure providers (see repo README,
  # "Module conventions"). aws.us_east_1 is a configuration_aliases entry, not a
  # configured provider — CloudFront's ACM certificate must live in us-east-1
  # regardless of the stack's home region, so the root module supplies a second
  # aliased aws provider and passes it in via this module's `providers = {}` block.
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}
