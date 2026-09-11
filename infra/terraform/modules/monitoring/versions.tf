# This module needs three AWS providers, which is why — alone among this repo's child modules — it
# declares `required_providers` at all (see .github/workflows/terraform.yml's tflint note on why
# the others deliberately do not). `configuration_aliases` does not pin or configure anything; it
# declares that a caller must *pass* an `aws.us_east_1` and an `aws.dr`, and nothing else can
# express that.
#
# aws.us_east_1 is modules/cdn's reason: CloudFront only accepts ACM certificates issued in
# us-east-1, so the CDN certificate's `DaysToExpiry` metric — and therefore any alarm on it —
# exists only there. alerts.tf's own comments carry the rest.
#
# aws.dr is the root module's existing cross-region-backup alias (providers.tf, var.backup_dr_region)
# reused rather than adding a fourth region: synthetics.tf runs the black-box probe from it as the
# probe's second region (ST-263's "per region" / "regional failure alerts" acceptance criteria),
# so a regional network/DNS/edge failure is caught even though the application itself runs only in
# var.aws_region.
#
# No `required_version` and no version constraints: the root module (infra/terraform/versions.tf)
# pins Terraform and every provider version for the whole configuration, and restating them here
# would be a second place to update.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1, aws.dr]
    }
  }
}
