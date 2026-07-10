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
