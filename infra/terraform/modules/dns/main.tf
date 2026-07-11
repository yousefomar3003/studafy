# The public hosted zone is account-wide and owned by infra/terraform/bootstrap. Environment
# stacks receive its ID through bootstrap remote state and own only their additive SES records.
# This prevents dev/staging/prod from creating competing zones and preserves the existing Vercel
# and Private Email records during migration.
locals {
  zone_id = var.zone_id
}
