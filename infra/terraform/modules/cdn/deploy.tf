# IAM role a deploy job assumes via GitHub OIDC to (1) sync apps/web's built dist/ into the
# web-bundle bucket and (2) invalidate the CloudFront distribution — the "invalidation hook"
# deliverable. Trust condition is environment-scoped
# (repo:<github_repository>:environment:<environment>), the same shape as modules/registry's
# deploy_pull: this role can overwrite what every visitor to var.domain_name sees next, so it gets
# the tighter, GitHub-Environment-scoped trust boundary, not ci_push's blanket "any branch" one.
#
# Uses modules/registry's existing GitHub Actions OIDC provider (github_oidc_provider_arn) rather
# than creating a second one — AWS allows exactly one per URL per account, and that module's own
# main.tf comment already calls for reuse once a second caller needs GitHub OIDC. This module is
# that second caller.

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
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

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-cdn-deploy"
  description        = "Assumed by a GitHub Actions run deploying to the '${var.environment}' GitHub Environment, to sync apps/web's build output into ${aws_s3_bucket.web_bundle.id} and invalidate the CloudFront distribution."
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid    = "SyncWebBundle"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.web_bundle.arn}/*"]
  }

  statement {
    sid       = "ListWebBundle"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.web_bundle.arn]
  }

  statement {
    sid    = "InvalidateDistribution"
    effect = "Allow"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [aws_cloudfront_distribution.this.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${var.name_prefix}-cdn-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
