# `storage`

Two private S3 buckets — `app-files` and `backups-archive` — with public access blocked,
versioning on, SSE-S3 encryption, a deny-insecure-transport bucket policy, and lifecycle rules.
Key-scheme and prefix conventions (how `schoolId` is placed in object keys, and why):
[`docs/runbooks/storage-conventions.md`](../../../../docs/runbooks/storage-conventions.md).

## What this module does not do

- **It does not give `backups-archive` a CORS policy or the temp/reports lifecycle rules.**
  `app-files` is written by pre-signed URLs from a browser (`apps/web`); `backups-archive` is
  written by services/CI via the AWS SDK, which isn't subject to browser CORS at all. "Archive"
  also means durable retention — the ticket's 24h/7d expiry categories don't apply to it.
- **It does not create an IAM role, policy, or the code that generates pre-signed URLs.** Grant
  `s3:PutObject`/`s3:GetObject` on `app_files_bucket_arn` (scoped to the caller's `schoolId`
  prefix) to whichever role does that — no compute tier exists yet
  (`infra/terraform/README.md`), so that role doesn't exist yet either.
- **It does not manage a KMS key.** Encryption is SSE-S3 (`AES256`), not SSE-KMS — this project
  has no key management set up, the same "nothing to migrate from yet" reasoning `modules/redis`
  used for making TLS non-optional. Revisit if per-key access auditing becomes a real
  requirement.

## Baseline hardening (both buckets)

| Control                      | Setting                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| Public access block          | All four settings `true`                                             |
| Object ownership             | `BucketOwnerEnforced` (ACLs disabled entirely)                       |
| Versioning                   | `Enabled`                                                            |
| Encryption                   | SSE-S3, `AES256`                                                     |
| Transport                    | Bucket policy denies any request where `aws:SecureTransport = false` |
| Noncurrent version cleanup   | Deleted after `noncurrent_version_expiration_days` (default 90)      |
| Incomplete multipart cleanup | Aborted after `abort_incomplete_multipart_days` (default 7)          |

The last two rows exist because versioning without cleanup is unbounded storage growth, not
because the ticket named them explicitly.

## app-files-only: CORS and lifecycle

CORS allows exactly **one** origin (`var.web_origin`) — not a wildcard, not a list — matching the
"CORS allows web origin only" acceptance criterion:

```hcl
allowed_methods = ["GET", "PUT", "POST", "HEAD"]
allowed_origins = [var.web_origin]
allowed_headers = ["*"]
expose_headers  = ["ETag"]
```

`POST`/`PUT` cover both single pre-signed `PUT` uploads and pre-signed multipart uploads
(`POST` to initiate/complete, `PUT` per part). `ETag` is exposed because a multipart client needs
each part's `ETag` to complete the upload.

| Lifecycle rule       | Scope             | Action                                                               |
| -------------------- | ----------------- | -------------------------------------------------------------------- |
| `temp-expiration`    | prefix `temp/`    | Expire after `temp_expiration_days` (default 1 = the ticket's "24h") |
| `reports-expiration` | prefix `reports/` | Expire after `reports_expiration_days` (default 7)                   |

S3 lifecycle expiration has no sub-day granularity, so "24h" is implemented as 1 day, not an
approximation of it.

## Usage

```hcl
module "storage" {
  source = "./modules/storage"

  name_prefix = module.naming.name_prefix
  web_origin  = var.web_origin
}
```

## Verifying lifecycle rules with test objects

Lifecycle rules don't delete on a timer you can watch — S3 evaluates them once daily and the
exact run time isn't published. What you _can_ verify immediately is that the rule is attached
and that S3 has computed the correct expiration date for an object under each prefix, via the
`x-amz-expiration` response header:

```bash
BUCKET="$(terraform output -raw storage_app_files_bucket_id)"

# temp/ — expect a date ~1 day out
echo "test" | aws s3 cp - "s3://$BUCKET/temp/verify.txt"
aws s3api head-object --bucket "$BUCKET" --key temp/verify.txt --query Expiration --output text

# reports/ — expect a date ~7 days out
echo "test" | aws s3 cp - "s3://$BUCKET/reports/verify.txt"
aws s3api head-object --bucket "$BUCKET" --key reports/verify.txt --query Expiration --output text

# Confirm the rules themselves are attached as expected:
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"

aws s3 rm "s3://$BUCKET/temp/verify.txt"
aws s3 rm "s3://$BUCKET/reports/verify.txt"
```

To verify a rule actually fires, re-run `head-object` after the date `Expiration` reported —
S3 deletes the object without further action needed.

## Verifying CORS

```bash
BUCKET="$(terraform output -raw storage_app_files_bucket_id)"
REGION="$(terraform output -raw aws_region)"

curl -sI -X OPTIONS \
  -H "Origin: <web_origin value>" \
  -H "Access-Control-Request-Method: PUT" \
  "https://$BUCKET.s3.$REGION.amazonaws.com/temp/probe" | grep -i access-control

# A disallowed origin must get no Access-Control-Allow-Origin header back:
curl -sI -X OPTIONS \
  -H "Origin: https://not-the-web-origin.example" \
  -H "Access-Control-Request-Method: PUT" \
  "https://$BUCKET.s3.$REGION.amazonaws.com/temp/probe" | grep -i access-control
```

## Inputs

| Name                                 | Type     | Default | Description                                                                       |
| ------------------------------------ | -------- | ------- | --------------------------------------------------------------------------------- |
| `name_prefix`                        | `string` | —       | Resource name prefix, from `module.naming.name_prefix`.                           |
| `web_origin`                         | `string` | —       | The single browser origin allowed by CORS on `app-files`.                         |
| `temp_expiration_days`               | `number` | `1`     | Days before `temp/` objects expire.                                               |
| `reports_expiration_days`            | `number` | `7`     | Days before `reports/` objects expire.                                            |
| `noncurrent_version_expiration_days` | `number` | `90`    | Placeholder — no researched retention policy exists yet.                          |
| `abort_incomplete_multipart_days`    | `number` | `7`     | Days before an abandoned multipart upload is aborted.                             |
| `force_destroy`                      | `bool`   | `false` | Allow `terraform destroy` to remove a non-empty bucket. Keep `false` outside dev. |

## Outputs

| Name                                    | Description                                                         |
| --------------------------------------- | ------------------------------------------------------------------- |
| `app_files_bucket_id`                   | Bucket name.                                                        |
| `app_files_bucket_arn`                  | For scoping IAM policies on the pre-signed-URL-generating role.     |
| `app_files_bucket_regional_domain_name` | Virtual-hosted-style regional domain, for building pre-signed URLs. |
| `backups_archive_bucket_id`             | Bucket name.                                                        |
| `backups_archive_bucket_arn`            | For scoping IAM policies on the backup job's role.                  |
