# Non-secret backend coordinates for the prod state. Credentials are NEVER put here;
# they resolve from the AWS credential chain (see infra/terraform/README.md).
#
#   terraform init -reconfigure -backend-config=environments/prod/backend.hcl

bucket = "studafy-tfstate-prod"
key    = "prod/terraform.tfstate"
region = "eu-central-1"

encrypt      = true
use_lockfile = true # S3-native state locking; no DynamoDB table required
