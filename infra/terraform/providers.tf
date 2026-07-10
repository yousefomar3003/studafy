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
