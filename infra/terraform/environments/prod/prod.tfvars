# Environment-specific inputs for the prod overlay. Non-secret by construction:
# secrets are supplied via TF_VAR_* environment variables or a secrets manager,
# never committed here. See infra/terraform/README.md.

environment = "prod"
aws_region  = "eu-central-1"
