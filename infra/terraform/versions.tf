terraform {
  # 1.11 is the first release where S3-native state locking (`use_lockfile`) is
  # generally available, which is what backend.tf relies on instead of DynamoDB.
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # Used by modules/redis and modules/pgbouncer to generate credentials. Needs no provider
    # block of its own — it has nothing to authenticate against.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Used by modules/pgbouncer to generate its self-signed client-facing TLS CA and leaf cert.
    # Needs no provider block of its own — it authenticates against nothing external.
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
