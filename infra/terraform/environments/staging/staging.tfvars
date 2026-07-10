# Environment-specific inputs for the staging overlay. Non-secret by construction:
# secrets are supplied via TF_VAR_* environment variables or a secrets manager,
# never committed here. See infra/terraform/README.md.
#
# bastion_allowed_ssh_cidrs and bastion_key_name are deliberately absent: supply them
# via TF_VAR_bastion_allowed_ssh_cidrs / TF_VAR_bastion_key_name (see variables.tf).

environment = "staging"
aws_region  = "eu-central-1"

# Non-overlapping with dev (10.0.0.0/16) and prod (10.2.0.0/16) so the VPCs can be
# peered later without renumbering.
vpc_cidr = "10.1.0.0/16"

az_count           = 2
single_nat_gateway = true # cost over HA in staging

# Placeholder, not a researched/confirmed domain: apps/web has no hosting decision recorded
# anywhere in this repo (unlike apps/mobile, which already hardcodes staging-api.studafy.com).
# Named by analogy with that host. Update before this environment's first real deploy.
web_origin = "https://staging.studafy.com"
