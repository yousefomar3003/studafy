# ADR-004: Infrastructure as Code with Terraform

## Status

Accepted

## Context

The repo has no infrastructure of any kind: no `infra/` directory, no container definitions, no
CI/CD, and no cloud provider referenced anywhere in the tree. Meanwhile the code has already
committed to a deployment shape — `apps/api` and `apps/realtime` are long-running Bun services
that expose `/healthz` and `/readyz` probes explicitly "so load balancers stop routing"
(`apps/api/README.md`), `apps/workers` is a BullMQ consumer, all three need Redis, and `apps/web`
builds to a static bundle. `apps/mobile` already ships `dev`/`staging`/`prod` build flavours
(`apps/mobile/lib/src/core/config/app_environment.dart`) that point at
`https://staging-api.studafy.com` and `https://api.studafy.com` — hosts that do not exist yet.

Provisioning that by hand in a console would put the environment definitions outside version
control, which is the same failure mode ADR-002 rejected for authorization data: a change that
does not show up as a diff in a PR is not auditable. We need a foundation before any of it is
built, and it needs to serve three environments without becoming three copies of itself.

## Decision

- **Terraform** manages cloud infrastructure, rooted at `infra/terraform/`. AWS is the target
  provider (`hashicorp/aws ~> 6.0`, `required_version >= 1.11.0, < 2.0.0`). `infra/` is not a Bun
  workspace and is not added to the `apps/*` / `packages/*` globs — Turbo has no task to run there.
- **One root module, three thin overlays.** The `*.tf` files at `infra/terraform/` are the entire
  configuration. An environment is `environments/<env>/backend.hcl` (where its state lives) plus
  `environments/<env>/<env>.tfvars` (its input values) — nothing else. Adding an environment
  touches no `*.tf` file in the root module.

  ```bash
  terraform init -reconfigure -backend-config=environments/prod/backend.hcl
  terraform plan -var-file=environments/prod/prod.tfvars
  ```

- **Remote state in S3, one bucket per environment**, with locking via `use_lockfile = true` —
  Terraform's S3-native conditional-put lock object, not a DynamoDB table. `backend.tf` holds an
  empty `backend "s3" {}` block; every value is injected at init time from the environment's
  `backend.hcl`. Separate buckets mean a `dev` misconfiguration cannot reach `prod` state and
  IAM can grant access per environment.
- **Credentials are never in the repo.** No `access_key`, `profile` or `role_arn` in any committed
  file. The AWS provider resolves credentials from the standard chain (env vars, SSO, OIDC in CI).
  `*.tfvars` is gitignored by default with the three non-secret environment overlays explicitly
  re-included; application secrets are passed as `TF_VAR_*` or read from a secrets manager.
- **Exactly one module today**: `modules/naming`, which derives `name_prefix` and the canonical
  `Project`/`Environment`/`ManagedBy` tag set from `project` + `environment`. It declares no
  resources. Resource names come from its `name_prefix` and tags are inherited through the
  provider's `default_tags`, so no resource ever restates either.
- **Terraform's `environment` axis is `dev | staging | prod`**, validated in `variables.tf`,
  matching the mobile flavours. It is deliberately not the services' runtime `NODE_ENV`
  (`development | test | production`, `apps/api/src/env.ts`) — those describe how a process
  behaves, not which infrastructure it runs on, and conflating them would force a `test`
  environment into the state layout and leave `staging` unrepresentable.

## Alternatives considered

- **A root module per environment (`environments/<env>/*.tf`, each with its own `backend.tf` and
  `providers.tf`)** — lets `terraform init` run in-place per directory with no `-reconfigure`
  dance. Rejected: it duplicates the provider and backend declarations three times, so a provider
  version bump becomes a three-file change and the environments drift silently the first time
  someone forgets one. The chosen layout pays for that with `-reconfigure` when switching
  environments, which is documented and mechanical.
- **Terraform workspaces (`terraform workspace select prod`)** — one state file, one backend, no
  duplication at all. Rejected: all workspaces share a single bucket and a single set of
  credentials, so "prod state is not reachable with dev credentials" cannot be expressed, and
  `terraform destroy` in the wrong workspace is one command away. Workspaces suit ephemeral
  variants of an environment, not the prod/non-prod boundary.
- **DynamoDB table for state locking** — the long-standing pattern, and still required before
  Terraform 1.10. Rejected: `use_lockfile` gives the same mutual exclusion using the state bucket
  itself, removing a table to provision, pay for and grant IAM on. The `dynamodb_table` backend
  argument is deprecated as of 1.11.
- **HCP Terraform (Terraform Cloud)** — managed state, locking and runs, with no bucket to
  bootstrap by hand. Rejected for now: it introduces a vendor account and a per-seat cost before
  a single resource exists, and the S3 backend can be migrated to it later with
  `terraform init -migrate-state` if run history and policy enforcement become worth paying for.
- **Pulumi or AWS CDK (infrastructure in TypeScript)** — appealing in a TS monorepo, since the
  infra could import from `packages/constants`. Rejected: both compile to an imperative program
  whose plan output is harder to review than HCL's, and CDK binds us to AWS at the language level.
  Terraform's `plan` diff is the artifact a reviewer actually reads on an infra PR.
- **A `remote-state-backend` bootstrap module that creates its own bucket** — solves the
  chicken-and-egg problem in code. Rejected as premature: it would be applied exactly once per
  environment with a local state file that then has to be migrated, and the four `aws s3api`
  commands it replaces are documented in `infra/terraform/README.md`. Revisit if the number of
  environments grows past what a one-time manual step can serve.

## Consequences

- Switching environments requires `terraform init -reconfigure`. Forgetting it plans against the
  previously initialised backend, so any CI job must always init before it plans. This is the
  cost of not duplicating the backend declaration, and it is called out in the README.
- The state bucket for a new environment must be created out of band before its first `init`.
  Terraform cannot create the bucket that holds its own state.
- `terraform plan` cannot run without an initialised backend, so a contributor with no AWS
  credentials plans by dropping in a temporary local-backend override (`*_override.tf`, gitignored).
  `terraform validate` and `terraform fmt` need neither backend nor credentials.
- The baseline provisions nothing. `terraform apply` on a configured backend writes outputs and
  no resources. The first ticket to add real infrastructure is also the first one that needs an
  AWS account, a state bucket, and a decision about the region — `eu-central-1` in the overlays is
  a placeholder, not a researched choice.
- Adding a second module is a deliberate act: modules take their names from `module.naming` and
  declare no providers, so they stay callable from any environment. A module that configures its
  own provider is a review finding, not a silent allowance.
- Nothing here enforces the security posture in CI. There is no secret scanner and no
  `terraform fmt -check` gate in the repo (there is no CI at all). Wiring `terraform validate`,
  `fmt -check` and a secret scanner into a pipeline — and using GitHub OIDC rather than long-lived
  keys — is follow-up work that this ADR assumes, not work it delivers.
