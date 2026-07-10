# One ECR repository per long-running service (api, realtime, workers — the three services
# ADR-004 already commits to a container deployment shape for; apps/web builds to a static bundle
# and apps/mobile is not containerized, so neither gets a repository here), plus the identities
# and signing key the supply-chain acceptance criteria hang off:
#
#   - module.registry.ci_push_role_arn   — assumed by CI via GitHub OIDC, push-only, no compute
#     tier exists yet to assume it as anything other than a CI job (infra/terraform/README.md).
#   - module.registry.deploy_pull_role_arn — assumed only by a workflow run deploying to the
#     GitHub Environment matching var.environment, pull-only.
#   - module.registry.signing_key_arn    — an asymmetric KMS key cosign signs with
#     (`cosign sign --key awskms:///<alias>`), so the private key material never leaves KMS and
#     never touches Terraform state — the one property a locally-generated cosign keypair
#     resource could not offer.
#
# Full rationale, the exact CI/deploy commands, and the honest gap around "unsigned images
# rejected by deploy policy" (no ECS/EKS/admission controller exists yet to enforce this at the
# cluster level — it's a CI pipeline gate today): ../../../../docs/runbooks/supply-chain-security.md

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  repositories = toset(var.image_repository_names)
}

# --- ECR repositories -------------------------------------------------------

resource "aws_ecr_repository" "this" {
  for_each = local.repositories

  name = "${var.name_prefix}/${each.value}"

  # IMMUTABLE, not the default MUTABLE: a tag that can be silently overwritten after it's been
  # scanned and signed defeats both scanning and signing — the digest cosign signed and the
  # digest a deploy later pulls by tag must be guaranteed to be the same image.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Untagged images accumulate from IMMUTABLE's own rejection behavior (a retried push of an
# existing tag lands as a new, unreferenced digest) and from manifest cleanup — same "versioning
# without cleanup is unbounded growth" reasoning as modules/storage's noncurrent-version rule.
resource "aws_ecr_lifecycle_policy" "untagged" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_expiration_days
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}

# --- cosign signing key ------------------------------------------------------

# ECC_NIST_P256 is the curve cosign's awskms provider expects. SIGN_VERIFY (not ENCRYPT_DECRYPT):
# this key only ever signs image digests, it never wraps data.
resource "aws_kms_key" "image_signing" {
  description              = "Asymmetric signing key for cosign image signatures (${var.name_prefix})."
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = var.signing_key_deletion_window_days

  # No `enable_key_rotation`: KMS does not support automatic rotation for asymmetric keys at all
  # (not a setting this module opted out of). Manual re-key procedure if rotation is ever
  # required: docs/runbooks/supply-chain-security.md.
  policy = data.aws_iam_policy_document.signing_key.json
}

resource "aws_kms_alias" "image_signing" {
  name          = "alias/${var.name_prefix}-image-signing"
  target_key_id = aws_kms_key.image_signing.key_id
}

# Replaces the default "account root gets kms:*" key policy with one scoped to exactly the two
# roles below, plus the account-root administration statement AWS requires every key policy to
# carry (without it, the key becomes unmanageable by IAM — this is a KMS constraint, not a choice
# to keep root's broad access).
data "aws_iam_policy_document" "signing_key" {
  statement {
    sid    = "AccountRootAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "CiPushMaySign"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.ci_push.arn]
    }
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
  }

  statement {
    sid    = "DeployPullMayVerify"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.deploy_pull.arn]
    }
    actions   = ["kms:Verify", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
  }
}

# --- GitHub Actions OIDC federation ------------------------------------------

# Account-wide singleton: AWS allows exactly one OIDC provider per URL per account. This module
# owns it because it is the first (and, as of this ticket, only) caller that needs GitHub OIDC —
# if a second module ever needs to trust GitHub Actions, move this resource to the root module
# rather than declaring a second one (Terraform module conventions, infra/terraform/README.md).
resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # GitHub's documented root CA thumbprint. AWS no longer actually validates this value against
  # the live TLS chain for well-known providers like this one, but the API still requires the
  # argument, so it is supplied for correctness against older provider behavior too.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# --- CI push role -------------------------------------------------------------

# repo:<owner>/<repo>:* — any branch, any workflow in this repo. Push is the lower-sensitivity
# side (see deploy_pull below for the tighter, environment-scoped trust condition); tightening
# this further to specific branches is a CI-workflow-shape decision this module can't make yet
# (infra/terraform/README.md: no CI/CD exists in this repo yet either).
data "aws_iam_policy_document" "ci_push_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

resource "aws_iam_role" "ci_push" {
  name               = "${var.name_prefix}-ecr-ci-push"
  description        = "Assumed by GitHub Actions via OIDC to build, push and cosign-sign images into ${var.name_prefix}'s ECR repositories."
  assume_role_policy = data.aws_iam_policy_document.ci_push_trust.json
}

data "aws_iam_policy_document" "ci_push" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # not a repository-scoped action — ECR has no ARN to scope it to.
  }

  statement {
    sid    = "EcrPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",  # cosign resolves the digest of what it just pushed via this
      "ecr:DescribeImages", # lets CI confirm the tag landed before signing it
    ]
    resources = [for repo in aws_ecr_repository.this : repo.arn]
  }
}

resource "aws_iam_role_policy" "ci_push" {
  name   = "${var.name_prefix}-ecr-ci-push"
  role   = aws_iam_role.ci_push.id
  policy = data.aws_iam_policy_document.ci_push.json
}

# --- Deploy pull role ---------------------------------------------------------

# repo:<owner>/<repo>:environment:<var.environment> — not repo:...:* like ci_push. Only a
# workflow run deploying to the GitHub Environment named after this Terraform environment (e.g.
# "staging") can assume this role, which is the IAM half of "in staging": it restricts *who* can
# pull, but IAM cannot inspect an image's signature — the "unsigned images rejected" half is a
# `cosign verify` gate the deploy job must run before pulling, documented in
# docs/runbooks/supply-chain-security.md, not something this role or its policy can enforce.
data "aws_iam_policy_document" "deploy_pull_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "deploy_pull" {
  name               = "${var.name_prefix}-ecr-deploy-pull"
  description        = "Assumed by a GitHub Actions run deploying to the '${var.environment}' GitHub Environment, to pull and cosign-verify images from ${var.name_prefix}'s ECR repositories."
  assume_role_policy = data.aws_iam_policy_document.deploy_pull_trust.json
}

data "aws_iam_policy_document" "deploy_pull" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPull"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [for repo in aws_ecr_repository.this : repo.arn]
  }
}

resource "aws_iam_role_policy" "deploy_pull" {
  name   = "${var.name_prefix}-ecr-deploy-pull"
  role   = aws_iam_role.deploy_pull.id
  policy = data.aws_iam_policy_document.deploy_pull.json
}

# --- Repository policy: least privilege enforced at the resource, not just the identity --------

# An IAM identity policy granting these two roles their actions is necessary but, on its own, not
# sufficient for "least privilege push/pull": any other role an admin later grants broad ecr:*
# would also work, silently, with no diff against this module. These Deny statements close that
# gap at the resource itself — same belt-and-suspenders reasoning as modules/storage's
# deny-insecure-transport bucket policy.
data "aws_iam_policy_document" "repository_policy" {
  statement {
    sid    = "DenyPushExceptCiPush"
    effect = "Deny"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions = [
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.ci_push.arn]
    }
  }

  statement {
    sid    = "DenyPullExceptCiPushAndDeployPull"
    effect = "Deny"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      # ci_push also needs read access (BatchGetImage/DescribeImages) to resolve and confirm the
      # digest it just pushed (see EcrPush above) — it is exempted here for that reason, not
      # because it's meant to pull unrelated images.
      values = [aws_iam_role.ci_push.arn, aws_iam_role.deploy_pull.arn]
    }
  }
}

resource "aws_ecr_repository_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy     = data.aws_iam_policy_document.repository_policy.json
}
