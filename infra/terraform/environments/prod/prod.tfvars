# Environment-specific inputs for the prod overlay. Non-secret by construction:
# secrets are supplied via TF_VAR_* environment variables or a secrets manager,
# never committed here. See infra/terraform/README.md.
#
# bastion_allowed_ssh_cidrs and bastion_key_name are deliberately absent: supply them
# via TF_VAR_bastion_allowed_ssh_cidrs / TF_VAR_bastion_key_name (see variables.tf).

environment = "prod"
aws_region  = "eu-central-1"

# Non-overlapping with dev (10.0.0.0/16) and staging (10.1.0.0/16) so the VPCs can be
# peered later without renumbering.
vpc_cidr = "10.2.0.0/16"

az_count           = 3
single_nat_gateway = false # one NAT gateway per AZ: no single point of failure in prod

# Placeholder, not a researched/confirmed domain: apps/web has no hosting decision recorded
# anywhere in this repo (unlike apps/mobile, which already hardcodes api.studafy.com). Named
# by analogy with that host. Update before this environment's first real deploy.
web_origin = "https://app.studafy.com"
