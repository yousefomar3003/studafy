# Supply-chain security note: container registry and image signing

Source of the resources this doc describes:
[`infra/terraform/modules/registry`](../../infra/terraform/modules/registry). That module
provisions the registry, the two IAM identities, and the signing key; this doc is the conventions
CI and any future deploy tooling must follow to use them correctly, and — the part that can't be
answered with Terraform alone — how "unsigned images rejected in staging" is actually enforced
today versus what it needs once a compute tier exists.

## Threat model, briefly

Two things this setup defends against:

1. **A build that isn't ci_push pushing into the registry** — a compromised laptop, a
   contributor's personal AWS credentials, or a different CI system entirely. Defended by the
   registry's resource policy (`DenyPushExceptCiPush` in `modules/registry/main.tf`) plus
   `ci_push`'s IAM policy being scoped to exactly the repositories this module owns.
2. **A tampered or unauthorized image being deployed even though it never went through CI** —
   e.g. someone with registry pull/push access outside CI pushes a tag directly, or an attacker
   who compromises the registry itself substitutes an image. Defended by cosign signing every
   image CI builds, and any deploy step refusing to proceed against an image whose signature
   doesn't verify against the signing key.

What this **doesn't** defend against: a compromise of the `ci_push` role's OIDC trust itself (e.g.
a malicious workflow run merged into a trusted branch) — that's a source-control/branch-protection
problem, out of scope for a registry module.

## Identities

| Role          | Trust condition (GitHub OIDC `sub` claim)                                                                                                                                                                                        | Can                | Cannot                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------- |
| `ci_push`     | `repo:<github_repository>:*` — any branch/workflow in this repo                                                                                                                                                                  | Push, `kms:Sign`   | Pull anything it didn't just push, `kms:Verify` |
| `deploy_pull` | `repo:<github_repository>:environment:<environment>` — only a run deploying to that named [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) | Pull, `kms:Verify` | Push, `kms:Sign`                                |

Both are assumed via `aws-actions/configure-aws-credentials`'s `role-to-assume` with no long-lived
AWS keys in GitHub secrets — the same OIDC-over-static-keys posture
`infra/terraform/README.md` already calls for.

**Why `deploy_pull` is environment-scoped and `ci_push` isn't:** pushing a built image is the same
operation regardless of which environment it'll later be deployed to; deploying is not — a run
deploying to `staging` has no business being able to assume the role that pulls for `prod`. GitHub
Environments give a `sub` claim (`environment:staging`) that IAM's trust condition can check
directly, so the "in staging" half of the acceptance criterion is a real IAM boundary, not just a
convention.

## CI: build, push, sign

Dockerfiles for `apps/api`, `apps/realtime` and `apps/workers` live in `infra/docker/` — see
`infra/docker/README.md` for what each image contains. Once CI assumes `ci_push_role_arn`:

```bash
REPO_URL="$(terraform -chdir=infra/terraform output -json registry_repository_urls | jq -r '.api')"
DIGEST_TAG="${REPO_URL}:$(git rev-parse --short HEAD)"

aws ecr get-login-password --region "$(terraform -chdir=infra/terraform output -raw aws_region)" \
  | docker login --username AWS --password-stdin "${REPO_URL%%/*}"

# Build context is the repo root, not apps/api: apps/realtime and apps/workers depend on
# packages/constants, and apps/web (nginx, not in this registry — see infra/docker/README.md's
# "Known gaps") depends on packages/ui, neither of which exists inside apps/<name>/ alone. Using
# the repo root uniformly for all four keeps the same invocation shape regardless of which image
# is being built. See infra/docker/README.md for the full build/stage breakdown.
docker build -f infra/docker/api.Dockerfile -t "$DIGEST_TAG" .
docker push "$DIGEST_TAG"

DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$DIGEST_TAG" | cut -d@ -f2)"

KEY="awskms:///$(terraform -chdir=infra/terraform output -raw registry_signing_key_alias)"
cosign sign --key "$KEY" --yes "${REPO_URL}@${DIGEST}"
```

`--yes` skips cosign's interactive confirmation prompt, appropriate in a non-interactive CI job.
No private key file, env var, or Terraform output holds signing key material anywhere in this
flow — `cosign` calls KMS's `Sign` API directly through the assumed `ci_push` role.

## Deploy (staging): pull, verify, reject if unsigned

```bash
KEY="awskms:///$(terraform -chdir=infra/terraform output -raw registry_signing_key_alias)"
IMAGE="${REPO_URL}@${DIGEST}"

if ! cosign verify --key "$KEY" "$IMAGE"; then
  echo "signature verification failed — refusing to deploy $IMAGE" >&2
  exit 1
fi

docker pull "$IMAGE"
# ... proceed with the deploy ...
```

**This `if`/`exit 1` block is the entire enforcement mechanism today.** There is no ECS/EKS
cluster, no admission controller, and no policy engine (Kyverno, OPA/Gatekeeper, AWS Signer's
container image signing check) anywhere in this repo — `infra/terraform/README.md` is explicit
that no compute tier exists yet. "Unsigned images rejected by deploy policy in staging" is
therefore implemented as a fail-closed step in whatever deploys to staging, not a property the
registry or cluster enforces independently of that step. Concretely, this means:

- An image that never got signed, or whose signature doesn't verify, fails this step and the
  deploy job stops. That satisfies the acceptance criterion for any deploy path that includes it.
- It does **not** stop someone with `deploy_pull`'s permissions (or broader ECR access) from
  pulling and running an unsigned image by some other path that skips this script — there's no
  cluster to intercept that pull, because there's no cluster yet.
- When a compute tier lands (ADR-004 references ECS as the likely direction), revisit this with a
  real admission-time check — ECS doesn't have a native equivalent of Kubernetes' admission
  webhooks, so that will likely mean either AWS Signer + ECR's signature-based pull restriction,
  or keeping the CI-gate approach if the deploy path stays entirely CI-driven (no separate runtime
  pull outside a deploy job). This doc should be updated when that decision is made, not before —
  designing the enforcement mechanism now would be guessing at infrastructure that doesn't exist.

## Rotating the signing key

KMS does not support automatic rotation for asymmetric keys (`aws_kms_key.image_signing` in
`modules/registry/main.tf` has no `enable_key_rotation` — it's not a supported argument for this
key spec, not an omitted setting). To rotate manually:

1. Add a second `aws_kms_key`/`aws_kms_alias` pair to the module (or bump
   `signing_key_deletion_window_days`'s sibling resource — there is currently exactly one key, so
   this is a module change, not a variable flip).
2. Point CI's `cosign sign` at the new alias for all new images.
3. Keep the old key's IAM grants (or the key itself) alive until every image signed with it has
   either been redeployed with a new signature or aged out — cosign verify against an old image
   still needs the old public key.
4. Only then remove the old key from the module.

## Known gaps

- No `.github/workflows` file wires any of this together yet. `ci_push_role_arn`,
  `deploy_pull_role_arn`, `repository_urls` and `signing_key_alias` are the four outputs that
  workflow will consume once it's written — that's a separate, CI-scoped ticket.
- `apps/web` and `apps/mobile` are not in `image_repository_names`. `apps/mobile` is a native app,
  not containerized, and that's not in question. `apps/web` is more unsettled than this module's
  original comment (still on `modules/registry/main.tf`) assumed: it now has a Dockerfile
  (`infra/docker/web.Dockerfile`, nginx serving the static build) alongside its existing
  CDN-hosted static-bundle path (`modules/cdn`) — two live deployment shapes, only one of which
  has a registry repository. Adding `"web"` to `image_repository_names` is a one-line change
  _if_ the containerized path is the one that ships; see `infra/docker/README.md`'s "Known gaps"
  for the full context. Not resolved here — provisioning a repository ahead of that decision would
  be the same "guessing at infrastructure" this doc already avoids elsewhere.
