# AWS bootstrap

This stack owns account-wide resources shared by dev, staging, and prod: state buckets, the
Route 53 zone, GitHub's OIDC provider, and protected Terraform roles. It targets account
`862910165270` and refuses to report success for a different caller account.

S3 cannot use a bucket as its backend before that bucket exists. Create only the empty bootstrap
bucket with the AWS CLI, initialize the backend, and immediately import it so Terraform owns every
property from that point onward:

```bash
aws s3api create-bucket \
  --bucket studafy-tfstate-bootstrap-862910165270 \
  --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1
terraform init -backend-config=backend.hcl.example
terraform import 'aws_s3_bucket.state["bootstrap"]' studafy-tfstate-bootstrap-862910165270
terraform apply
```

The apply enables versioning, encryption, public-access blocking, and native S3 lockfiles on the
imported bucket and creates the isolated dev, staging, and production state buckets. Do not run a
local-state apply of this stack; that can strand the account-wide state on an operator machine.

Do not change registrar nameservers after this apply. Follow `docs/runbooks/dns-migration.md` and
compare the registrar's complete record export before cutover.
