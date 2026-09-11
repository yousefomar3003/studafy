# This module needs two AWS providers, which is why — alone among this repo's child modules — it
# declares `required_providers` at all (see .github/workflows/terraform.yml's tflint note on why
# the others deliberately do not). `configuration_aliases` does not pin or configure anything; it
# declares that a caller must *pass* an `aws.us_east_1`, and nothing else can express that.
#
# The reason is modules/cdn's reason: CloudFront only accepts ACM certificates issued in us-east-1,
# so the CDN certificate's `DaysToExpiry` metric — and therefore any alarm on it — exists only
# there. alerts.tf's own comments carry the rest.
#
# No `required_version` and no version constraints: the root module (infra/terraform/versions.tf)
# pins Terraform and every provider version for the whole configuration, and restating them here
# would be a second place to update.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}
