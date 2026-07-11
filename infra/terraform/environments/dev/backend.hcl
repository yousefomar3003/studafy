# Non-secret backend coordinates for the dev state. Credentials are NEVER put here;
# they resolve from the AWS credential chain (see infra/terraform/README.md).
#
#   terraform init -reconfigure -backend-config=environments/dev/backend.hcl

bucket = "studafy-tfstate-dev-862910165270"
key    = "dev/terraform.tfstate"
region = "eu-central-1"

encrypt      = true
use_lockfile = true # S3-native state locking; no DynamoDB table required
