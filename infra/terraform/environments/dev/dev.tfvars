# Environment-specific inputs for the dev overlay. Non-secret by construction:
# secrets are supplied via TF_VAR_* environment variables or a secrets manager,
# never committed here. See infra/terraform/README.md.
#
# bastion_allowed_ssh_cidrs and bastion_key_name are deliberately absent: supply them
# via TF_VAR_bastion_allowed_ssh_cidrs / TF_VAR_bastion_key_name (see variables.tf).

environment = "dev"
aws_region  = "eu-central-1"

# Non-overlapping with staging (10.1.0.0/16) and prod (10.2.0.0/16) so the VPCs can be
# peered later without renumbering.
vpc_cidr = "10.0.0.0/16"

az_count           = 2
single_nat_gateway = true # cost over HA in dev

# The actual Vite dev server default (apps/web/README.md), not a guess.
web_origin = "http://localhost:5173"

# Placeholder, not a researched/confirmed domain: apps/mobile's dev flavor talks to the Android
# emulator loopback (10.0.2.2), not a DNS name, so unlike staging/prod there is no existing
# hardcoded value to match here. Named by analogy with staging-api/api. Update before dev's edge
# stack is first applied for real, or point it at a zone dev actually owns.
edge_domain_name  = "dev-api.studafy.com"
route53_zone_name = "studafy.com"
