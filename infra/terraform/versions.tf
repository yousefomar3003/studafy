terraform {
  # 1.11 is the first release where S3-native state locking (`use_lockfile`) is
  # generally available, which is what backend.tf relies on instead of DynamoDB.
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
