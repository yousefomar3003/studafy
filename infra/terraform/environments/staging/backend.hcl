# Non-secret backend coordinates for the staging state. Credentials are NEVER put here;
# they resolve from the AWS credential chain (see infra/terraform/README.md).
#
#   terraform init -reconfigure -backend-config=environments/staging/backend.hcl

bucket = "studafy-tfstate-staging-862910165270"
key    = "staging/terraform.tfstate"
region = "eu-central-1"

encrypt      = true
use_lockfile = true # S3-native state locking; no DynamoDB table required
