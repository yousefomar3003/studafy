# QA-071: leftover AWS resources (filled in by the account owner)

Production left AWS for fly.io, Supabase, Redis Cloud and Cloudflare R2. The repository no longer
holds any AWS infrastructure code: `infra/terraform/` has been gitignored since the move, and its
code lives in git history only. What may still exist is in the **AWS account** itself, and on the
machine where Terraform last ran. Nothing in this file was run by the QA session. Every command
below is for the owner to run, with credentials for that account.

**Known facts from the repository audit:**

- The last Terraform working directory (`infra/terraform/.terraform/terraform.tfstate`, backend
  metadata only) points at the S3 bucket `studafy-tfstate-prod-0079****0039` in `eu-central-1`,
  key `prod/terraform.tfstate`. That remote state probably holds old RDS master passwords in
  plaintext. Treat it as a secret.
- The same local directory holds about 814 MB of providers and 7 Lambda zips. It is untracked and
  exists only on that machine.
- Old RDS passwords no longer protect anything if RDS is gone, but confirm that (step 1) before you
  rely on it.

## 1. Inventory (read-only)

Set the profile for the Studafy account, then list everything still running or billing. Paste the
output, or "none", under each heading in the Results section below.

```sh
export AWS_PROFILE=<studafy profile> AWS_REGION=eu-central-1
aws sts get-caller-identity
aws resourcegroupstaggingapi get-resources --output table        # everything tagged, this region
for r in eu-central-1 us-east-1; do
  aws ecs list-clusters --region "$r"
  aws rds describe-db-instances --region "$r" --query 'DBInstances[].DBInstanceIdentifier'
  aws rds describe-db-snapshots --region "$r" --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier'
  aws elasticache describe-cache-clusters --region "$r" --query 'CacheClusters[].CacheClusterId'
  aws lambda list-functions --region "$r" --query 'Functions[].FunctionName'
  aws kms list-aliases --region "$r" --query 'Aliases[?!starts_with(AliasName, `alias/aws/`)].AliasName'
  aws backup list-backup-vaults --region "$r" --query 'BackupVaultList[].BackupVaultName'
  aws logs describe-log-groups --region "$r" --query 'logGroups[].logGroupName'
  aws ec2 describe-vpcs --region "$r" --filters Name=is-default,Values=false --query 'Vpcs[].VpcId'
  aws ec2 describe-nat-gateways --region "$r" --query 'NatGateways[?State!=`deleted`].NatGatewayId'
  aws ec2 describe-addresses --region "$r" --query 'Addresses[].PublicIp'
  aws secretsmanager list-secrets --region "$r" --query 'SecretList[].Name'
done
aws s3 ls
aws cloudfront list-distributions --query 'DistributionList.Items[].Id'
aws iam list-users --query 'Users[].UserName'
aws iam list-access-keys --user-name <each user above>
aws ce get-cost-and-usage --time-period Start=$(date -u -v-1m +%Y-%m-01),End=$(date -u +%Y-%m-01) \
  --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
```

(`date -v-1m` is macOS; on Linux use `date -u -d '1 month ago' +%Y-%m-01`.)

## 2. Archive the Terraform state, then remove the bucket

1. Download the state and every version of it, and encrypt it before it touches anything shared:

   ```sh
   B=studafy-tfstate-prod-<full bucket name>
   mkdir -m 700 tfstate-archive && cd tfstate-archive
   aws s3api list-object-versions --bucket "$B" --prefix prod/terraform.tfstate \
     --query 'Versions[].[VersionId]' --output text |
     while read -r v; do aws s3api get-object --bucket "$B" --key prod/terraform.tfstate \
       --version-id "$v" "terraform.tfstate.$v" >/dev/null; done
   cd .. && tar czf - tfstate-archive | age -p > studafy-tfstate-$(date +%F).tar.gz.age
   rm -rf tfstate-archive
   ```

   Keep the `.age` file and its passphrase in the password manager's secure-file store, not in the
   repository.

2. Only after everything in step 3 is gone (Terraform no longer needs the state), empty and delete
   the bucket, including old versions and the lock table if there is one:

   ```sh
   aws s3api delete-bucket-policy --bucket "$B" || true
   aws s3 rm "s3://$B" --recursive
   # versioned bucket: also delete every version and delete marker (S3 console "Empty" does both)
   aws s3api delete-bucket --bucket "$B"
   aws dynamodb list-tables     # delete a terraform lock table here if one is listed
   ```

## 3. Delete what is left

For each resource step 1 found, delete it in the console or with the matching `delete-*` command.
Order: ECS services → ECS clusters → load balancers → RDS instances (take a **final snapshot only
if** someone still needs the data; otherwise skip it) → ElastiCache → NAT gateways and Elastic IPs →
VPCs → Lambda → Backup vaults (Vault Lock may block this until retention expires; note the date) →
CloudWatch log groups → KMS keys (schedule deletion, 7–30 days) → Secrets Manager secrets.

## 4. Credentials and the account

1. Deactivate, then delete, every IAM access key from step 1 (`aws iam update-access-key --status
Inactive`, wait a week for anything that breaks, then `aws iam delete-access-key`).
2. If nothing else uses the account, close it (Billing console → Account → Close account), after
   downloading the last invoices.

## 5. The local Terraform directory

On the machine that still has `infra/terraform/` (it is untracked, so a fresh clone does not have
it): archive anything you want from it into the same encrypted file as step 2, then
`rm -rf infra/terraform`. The `.gitignore`, `.dockerignore` and `.gitleaks.toml` entries for it stay,
as guards.

## Results (owner fills in)

| Check                                               | Result | Date / by |
| --------------------------------------------------- | ------ | --------- |
| Inventory: resources still present (list)           |        |           |
| Terraform state archived (where the `.age` file is) |        |           |
| State bucket and lock table deleted                 |        |           |
| Remaining resources deleted                         |        |           |
| IAM access keys deactivated / deleted               |        |           |
| Cost Explorer shows $0 for the last full month      |        |           |
| Account closed (or why it stays open)               |        |           |
| Local `infra/terraform/` removed                    |        |           |
