terraform {
  # No provider block: modules never configure providers (see repo README,
  # "Module conventions"). This only pins the version this module was written
  # against; the root module supplies the actual random and aws providers.
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
