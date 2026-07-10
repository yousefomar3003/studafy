# `registry`

One ECR repository per containerized service, a cosign signing key backed by KMS, and the two
GitHub-OIDC-federated IAM roles the push/pull acceptance criteria need. Supply-chain conventions —
the exact CI push/sign and deploy verify/pull commands, and the honest gap around enforcing
"unsigned images rejected" without a compute tier yet — live in
[`docs/runbooks/supply-chain-security.md`](../../../../docs/runbooks/supply-chain-security.md).

## What this module does not do

- **It does not build, tag or push any image.** No Dockerfile exists in this repo yet for
  `apps/api`, `apps/realtime` or `apps/workers` (`infra/terraform/README.md`: no compute tier
  exists). This module provisions where images land and who may push/pull them, not the build.
- **It does not run cosign, or verify a signature.** `signing_key_arn`/`signing_key_alias` are
  outputs a CI job's own `cosign sign`/`cosign verify` invocation consumes — see the linked doc
  for the exact commands.
- **It does not create a policy engine, an ECS/EKS cluster, or an admission controller.** None
  exists in this repo (same gap `modules/redis`'s README calls out for connecting apps to Redis).
  "Unsigned images rejected by deploy policy in staging" is therefore implemented today as a CI
  pipeline gate (a `cosign verify` step the deploy job runs before pulling, that fails the job
  closed if it doesn't pass) — not a cluster-level admission policy. Revisit with
  Kyverno/Notation or AWS Signer once a compute tier exists to host one.
- **It does not scaffold a GitHub Actions workflow.** `.github/workflows` doesn't exist anywhere
  in this repo yet; that is a separate, CI-scoped ticket. This module's outputs
  (`ci_push_role_arn`, `deploy_pull_role_arn`, `signing_key_alias`, `repository_urls`) are what
  that workflow will need once it exists.

## Topology

| Resource                                         | Count                                                                            | Purpose                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws_ecr_repository`                             | one per `image_repository_names` entry (default 3: `api`, `realtime`, `workers`) | Named `<name_prefix>/<name>`, e.g. `studafy-prod/api`. `IMMUTABLE` tags, `scan_on_push`, SSE (`AES256`).                                                                                                  |
| `aws_ecr_lifecycle_policy`                       | one per repository                                                               | Expires untagged images after `untagged_image_expiration_days` (default 14).                                                                                                                              |
| `aws_ecr_repository_policy`                      | one per repository                                                               | Denies push to anyone but `ci_push`, denies pull to anyone but `ci_push`/`deploy_pull` — enforced at the resource, not just the IAM identity.                                                             |
| `aws_kms_key.image_signing`                      | 1                                                                                | `SIGN_VERIFY`, `ECC_NIST_P256` — the curve cosign's `awskms` provider expects. Key policy scoped to `ci_push` (sign) and `deploy_pull` (verify) plus the mandatory account-root administration statement. |
| `aws_iam_openid_connect_provider.github_actions` | 1 (account-wide singleton)                                                       | Federates GitHub Actions' OIDC tokens for both roles below.                                                                                                                                               |
| `aws_iam_role.ci_push`                           | 1                                                                                | Trust: `repo:<github_repository>:*` (any branch/workflow in this repo). Permissions: push actions + `kms:Sign` on the signing key, scoped to this module's repositories/key only.                         |
| `aws_iam_role.deploy_pull`                       | 1                                                                                | Trust: `repo:<github_repository>:environment:<environment>` — only a run deploying to the GitHub Environment named after this Terraform environment. Permissions: pull actions + `kms:Verify`.            |

Why `image_repository_names` is a variable with a default, not hardcoded `locals` like
`modules/storage`'s two buckets: that pair is fixed by what "app-files vs. backups-archive" means;
the set of containerized services here is expected to grow as new ones are scaffolded, and adding
one should not require editing this module.

## Least privilege, concretely

Neither role can do anything to the other's side of push/pull, and neither can touch the other
environment's `deploy_pull` role:

- `ci_push` cannot pull existing images for any purpose other than resolving the digest of what it
  just pushed (`ecr:BatchGetImage`), and cannot `kms:Verify` — it can only sign.
- `deploy_pull` cannot push, and cannot `kms:Sign` — it can only verify.
- `deploy_pull`'s trust condition is pinned to one Environment name (`environment:staging`, say).
  A workflow run deploying to `production` cannot assume the `staging`-environment's `deploy_pull`
  role, because GitHub's OIDC token's `sub` claim won't match.
- `ecr:GetAuthorizationToken` is the one exception on both roles — ECR does not expose a
  repository-scoped ARN for it, so it cannot be restricted further than `Resource = "*"`. Every
  other action is scoped to `aws_ecr_repository.this[*].arn`.

## Usage

```hcl
module "registry" {
  source = "./modules/registry"

  name_prefix = module.naming.name_prefix
  environment = var.environment
}
```

## Verifying the repository policy denies rogue pushes

```bash
# As any identity other than ci_push — expect AccessDeniedException even if that identity
# separately holds an ecr:PutImage-granting managed policy:
aws ecr get-login-password | docker login --username AWS --password-stdin \
  "$(terraform output -json registry_repository_urls | jq -r '.api' | cut -d/ -f1)"
docker push "$(terraform output -json registry_repository_urls | jq -r '.api'):probe"
# -> denied by the DenyPushExceptCiPush statement in aws_ecr_repository_policy.this
```

## Verifying cosign sign/verify against the KMS key

See `docs/runbooks/supply-chain-security.md` for the full CI push+sign and deploy verify+pull
command sequences. Minimal smoke test once `ci_push_role_arn` is assumed:

```bash
KEY="awskms:///$(terraform output -raw registry_signing_key_alias)"
cosign sign --key "$KEY" --yes "$(terraform output -json registry_repository_urls | jq -r '.api')@sha256:<digest>"
cosign verify --key "$KEY" "$(terraform output -json registry_repository_urls | jq -r '.api')@sha256:<digest>"
```

## Inputs

| Name                               | Type           | Default                          | Description                                                              |
| ---------------------------------- | -------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `name_prefix`                      | `string`       | —                                | Resource name prefix, from `module.naming.name_prefix`.                  |
| `environment`                      | `string`       | —                                | Scopes `deploy_pull`'s trust to the same-named GitHub Environment.       |
| `github_repository`                | `string`       | `"yousefomar3003/studafy"`       | `<owner>/<repo>` allowed to assume the CI roles via OIDC.                |
| `image_repository_names`           | `list(string)` | `["api", "realtime", "workers"]` | One repository per entry.                                                |
| `untagged_image_expiration_days`   | `number`       | `14`                             | Lifecycle cleanup for untagged images.                                   |
| `signing_key_deletion_window_days` | `number`       | `30`                             | KMS deletion waiting period (7-30) if the signing key is ever destroyed. |

## Outputs

| Name                       | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `repository_urls`          | Map of repo name -> full ECR URL, for `docker build -t` / `push`.                            |
| `repository_arns`          | Map of repo name -> ARN, for scoping any further IAM policy.                                 |
| `ci_push_role_arn`         | Assume via OIDC in the CI push/sign job.                                                     |
| `deploy_pull_role_arn`     | Assume via OIDC in the deploy job for this environment.                                      |
| `signing_key_arn`          | KMS key ARN. Private key material never leaves KMS.                                          |
| `signing_key_alias`        | Pass to cosign as `awskms:///<this value>`.                                                  |
| `github_oidc_provider_arn` | Account-wide singleton this module owns — see the caveat in `main.tf` before duplicating it. |
