provider "aws" {
  region = var.aws_region

  # Every resource created by this root module inherits the canonical tag set,
  # so individual resources never restate Project/Environment/ManagedBy.
  default_tags {
    tags = module.naming.tags
  }
}

# CloudFront only accepts ACM certificates issued in us-east-1, regardless of which region the rest
# of the stack lives in (var.aws_region is eu-central-1 for every environment) — a hard AWS
# constraint, not a regional preference. module.cdn is the only consumer; everything else it
# creates (the distribution itself, the S3 origin, Route 53 records) uses the default aws provider
# above, since CloudFront and Route 53 are global services with no region of their own.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = module.naming.tags
  }
}

# Cross-region automated-backups replication (ST-265, modules/backup/replication.tf) is a
# destination-side AWS API call (StartDBInstanceAutomatedBackupsReplication runs against the region
# receiving the copy, not the source) — module.backup is the only consumer, and it needs a real
# provider for var.backup_dr_region, the same "second region, second provider block" shape as
# us_east_1 above.
provider "aws" {
  alias  = "dr"
  region = var.backup_dr_region

  default_tags {
    tags = module.naming.tags
  }
}
