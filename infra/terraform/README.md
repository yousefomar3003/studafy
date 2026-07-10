# Infrastructure

Terraform configuration for Studafy's cloud infrastructure. Provider: AWS. State lives in S3
with native state locking.

This directory is **not** a Bun workspace — it is not matched by the `apps/*` / `packages/*`
globs in the root `package.json`, and Turbo does not run tasks against it.

> **Status:** `naming`, `network`, `redis`, `postgres`, `storage`, `registry`, `edge` and `cdn` are
> live —
> a VPC, subnets, security groups and a bastion host per environment, a Redis 7 HA pair with TLS
> and AUTH-token-in-Secrets-Manager, a Postgres 16 HA pair (RDS Multi-AZ) with TLS enforced,
> encrypted gp3 storage, and its master credential in Secrets Manager, two private S3 buckets
> (`app-files`, `backups-archive`) with SSE, versioning, lifecycle rules and single-origin CORS,
> per-service ECR repositories with a cosign/KMS signing key and GitHub-OIDC-federated push/pull
> IAM roles, and an internet-facing ALB with a DNS-validated ACM certificate, HTTP→HTTPS redirect,
> and a WAFv2 web ACL (OWASP core rule set, SQLi rule set, rate limits on `/auth` and
> `/schools/register`), and (staging/prod only) a CloudFront distribution in front of a private
> S3 origin serving `apps/web`'s built bundle, with a 1-year-immutable cache class for
> content-hashed assets, a no-cache class for HTML, and a GitHub-OIDC deploy role that syncs the
> bundle and invalidates the distribution — see `docs/runbooks/cdn-cache-policy.md`. No compute
> tier exists yet (no ECS/EC2); that lands in follow-up work and
> consumes `module.network`'s `app_security_group_id`, `module.postgres`'s
> `connection_secret_arn`, and `module.edge`'s `https_listener_arn`. Because no compute tier exists
> yet, `module.edge` creates no target group and its HTTPS listener's default action is a fixed
> `404` — see `modules/edge/README.md`. Likewise "apps connect to Redis/Postgres over TLS" and
> "instance reachable from the app subnet only" are verified today with a manual client against the
> dev endpoint, not through a deployed `apps/api`/`apps/workers` — see `modules/redis/README.md`
> and `docs/runbooks/postgres-conventions.md`; no code in this repo yet generates a pre-signed URL
> against `module.storage`'s buckets — see `docs/runbooks/storage-conventions.md`; and no
> Dockerfile or CI workflow yet pushes into `module.registry`'s repositories — see
> `docs/runbooks/supply-chain-security.md`; and the same is true of `module.cdn`'s deploy role —
> no `.github/workflows` file yet runs the `apps/web` build + sync + invalidate sequence it's
> meant for — see `docs/runbooks/cdn-cache-policy.md`.

## Folder structure

```
infra/terraform/
├── versions.tf              required_version + pinned providers
├── backend.tf               remote state backend (partial config, no values)
├── providers.tf             AWS provider + default_tags
├── variables.tf             root inputs, with validation
├── main.tf                  module wiring
├── outputs.tf               root outputs
├── .terraform.lock.hcl      provider checksums — committed
├── modules/
│   ├── naming/              canonical name prefix + tag set
│   ├── network/             VPC, subnets, security groups, bastion
│   ├── redis/               Redis 7 HA pair, TLS, AUTH token in Secrets Manager
│   ├── postgres/            Postgres 16 HA pair (RDS Multi-AZ), TLS, master credential in Secrets Manager
│   ├── storage/             app-files + backups-archive S3 buckets, SSE, versioning, CORS, lifecycle
│   ├── registry/            Per-service ECR repos, cosign/KMS signing key, GitHub-OIDC push/pull IAM roles
│   ├── edge/                ALB, DNS-validated ACM cert, HTTP->HTTPS redirect, WAFv2 (OWASP core + SQLi + rate limits)
│   └── cdn/                 CloudFront + private S3 origin for apps/web's bundle, immutable-asset/no-cache HTML classes, GitHub-OIDC deploy role (staging/prod only)
└── environments/
    ├── dev/     { backend.hcl, dev.tfvars }
    ├── staging/ { backend.hcl, staging.tfvars }
    └── prod/    { backend.hcl, prod.tfvars }
```

## Environment layout

There is **one root module** — the `*.tf` files above — shared by every environment. An
environment is not a copy of the configuration; it is two small files that parameterise it:

| File           | Purpose                                            | Consumed by                  |
| -------------- | -------------------------------------------------- | ---------------------------- |
| `backend.hcl`  | Which S3 bucket/key holds this environment's state | `init -backend-config=…`     |
| `<env>.tfvars` | Environment-specific input values                  | `plan`/`apply` `-var-file=…` |

`environment` is validated against `dev | staging | prod` in `variables.tf`. These names match
the mobile app's build flavours (`apps/mobile/lib/src/core/config/app_environment.dart`). They
are **not** the same axis as the services' runtime `NODE_ENV`, which is
`development | test | production` (`apps/api/src/env.ts`).

## Remote state and locking

Each environment gets a **separate state file in its own bucket**, so a mistake in `dev` cannot
corrupt `prod` state, and read access can be granted per environment:

| Environment | Bucket                    | Key                         |
| ----------- | ------------------------- | --------------------------- |
| dev         | `studafy-tfstate-dev`     | `dev/terraform.tfstate`     |
| staging     | `studafy-tfstate-staging` | `staging/terraform.tfstate` |
| prod        | `studafy-tfstate-prod`    | `prod/terraform.tfstate`    |

Locking uses `use_lockfile = true`: Terraform writes a conditional-put lock object
(`<key>.tflock`) next to the state. A second concurrent `plan`/`apply` fails to acquire the lock
and aborts. No DynamoDB table is involved.

`backend.tf` contains an empty `backend "s3" {}` block on purpose — every value is injected at
init time from `environments/<env>/backend.hcl`, and **no credential ever appears in either
file**.

### Backend setup (one-time, per environment)

The state bucket must exist before Terraform can store state in it — Terraform cannot create the
bucket that holds its own state. Create it once, out of band:

```bash
aws s3api create-bucket \
  --bucket studafy-tfstate-prod \
  --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1

# Versioning lets you recover from a corrupted or truncated state write.
aws s3api put-bucket-versioning \
  --bucket studafy-tfstate-prod \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket studafy-tfstate-prod \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# State is sensitive. It must never be publicly reachable.
aws s3api put-public-access-block \
  --bucket studafy-tfstate-prod \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## Provider configuration and authentication

`versions.tf` pins `hashicorp/aws ~> 6.0` — patch and minor upgrades are allowed, a major bump is
a deliberate change. `required_version` is `>= 1.11.0, < 2.0.0`; 1.11 is the first release with
generally-available S3-native locking.

Credentials are **never** committed and never read from a file in this repo. The provider resolves
them from the standard AWS credential chain, in order: environment variables, shared config
(`~/.aws/config`, e.g. `AWS_PROFILE`), SSO, and the instance/OIDC role in CI.

```bash
# Local, via a named profile:
export AWS_PROFILE=studafy-prod
export AWS_REGION=eu-central-1

# Or explicit keys (prefer SSO / OIDC where possible):
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
```

In CI, use GitHub's OIDC provider to assume a role — no long-lived keys in secrets.

Application secrets (`WS_JWT_SECRET`, `REDIS_URL`, …) do not belong in `*.tfvars`. Pass them as
`TF_VAR_<name>` environment variables, or read them from a secrets manager in the configuration.

## Module conventions

- A module lives in `modules/<name>/` with `main.tf`, `variables.tf`, `outputs.tf` and a `README.md`.
- Modules declare **no `provider` blocks and no `backend`** — those are the root module's job.
  A module that configures its own provider cannot be reused across environments.
- Every input has a `description` and a `type`; constrained inputs get a `validation` block.
- Resource names derive from `module.naming.name_prefix`. Tags are inherited from the provider's
  `default_tags` — do not restate `Project`/`Environment`/`ManagedBy` on individual resources.
- Add a module when a second caller needs it, not in anticipation of one.

## Common commands

Run everything from `infra/terraform/`. Substitute `dev`, `staging` or `prod` for `<env>`.

```bash
# Format (writes) and check formatting (read-only, for CI)
terraform fmt -recursive
terraform fmt -check -recursive

# Initialise against an environment's remote state. -reconfigure is required when
# switching environments, because the backend differs between them.
terraform init -reconfigure -backend-config=environments/<env>/backend.hcl

# Validate the configuration. Needs modules/providers installed, but no backend:
terraform init -backend=false && terraform validate

# Plan and apply an environment
terraform plan  -var-file=environments/<env>/<env>.tfvars
terraform apply -var-file=environments/<env>/<env>.tfvars
```

> **Switching environments:** the backend is per-directory state, not per-command. Always re-run
> `init -reconfigure` when moving between `dev`, `staging` and `prod`, or Terraform will plan
> against the previously initialised backend.

### Planning without AWS credentials

`terraform plan` requires an initialised backend, so `init -backend=false` alone is not enough.
To plan offline, drop in a temporary local-backend override — `*_override.tf` is gitignored:

```bash
printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
terraform init -reconfigure && terraform plan -var-file=environments/dev/dev.tfvars
rm backend_override.tf terraform.tfstate
```

This is a local convenience for validating configuration changes. Never commit the override.

## Adding an environment

1. `mkdir environments/<name>` and add `backend.hcl` + `<name>.tfvars`, copying an existing pair.
2. Point `backend.hcl` at that environment's own bucket and key.
3. Add `"<name>"` to the `environment` validation lists in `variables.tf` **and**
   `modules/naming/variables.tf`.
4. Create the state bucket (see _Backend setup_ above), then
   `terraform init -reconfigure -backend-config=environments/<name>/backend.hcl`.

No `*.tf` file in the root module changes.
