data "aws_caller_identity" "current" {}

locals {
  environments = toset(["dev", "staging", "prod"])
  state_buckets = merge(
    { bootstrap = "studafy-tfstate-bootstrap-${var.aws_account_id}" },
    { for env in local.environments : env => "studafy-tfstate-${env}-${var.aws_account_id}" },
  )
}

resource "aws_s3_bucket" "state" {
  for_each = local.state_buckets
  bucket   = each.value

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_route53_zone" "studafy" {
  name    = var.domain_name
  comment = "Studafy public DNS. Registrar delegation is changed only after parity checks pass."

  lifecycle {
    prevent_destroy = true
  }
}

# Records observed on the live registrar zone on 2026-07-11. The registrar export must be
# compared with this list before nameserver cutover so dormant DKIM/verification records are not
# lost merely because they cannot be discovered through public DNS enumeration.
resource "aws_route53_record" "apex_vercel" {
  zone_id = aws_route53_zone.studafy.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 1800
  records = ["216.198.79.1"]
}

resource "aws_route53_record" "www_vercel" {
  zone_id = aws_route53_zone.studafy.zone_id
  name    = "www.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["69a855717b020d6c.vercel-dns-017.com"]
}

resource "aws_route53_record" "private_email_mx" {
  zone_id = aws_route53_zone.studafy.zone_id
  name    = var.domain_name
  type    = "MX"
  ttl     = 1800
  records = ["10 mx1.privateemail.com", "10 mx2.privateemail.com"]
}

resource "aws_route53_record" "apex_txt" {
  zone_id = aws_route53_zone.studafy.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:spf.privateemail.com ~all", var.google_site_verification]
}

resource "aws_route53_record" "private_email_hosts" {
  for_each = toset(["mail", "autodiscover"])

  zone_id = aws_route53_zone.studafy.zone_id
  name    = "${each.value}.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["privateemail.com"]
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
  ]
}

data "aws_iam_policy_document" "github_environment_trust" {
  for_each = local.environments

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${each.value}"]
    }
  }
}

resource "aws_iam_role" "terraform_apply" {
  for_each = local.environments

  name               = "studafy-${each.value}-terraform-apply"
  assume_role_policy = data.aws_iam_policy_document.github_environment_trust[each.value].json
}

# PowerUserAccess covers the service resources. The scoped IAM statement below is the minimum
# additional capability Terraform needs to create Studafy task, deploy, and service roles.
resource "aws_iam_role_policy_attachment" "terraform_power_user" {
  for_each = aws_iam_role.terraform_apply

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "terraform_iam" {
  statement {
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:ListEntitiesForPolicy",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:UpdateRoleDescription",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/studafy-*",
      "arn:aws:iam::${var.aws_account_id}:policy/studafy-*",
    ]
  }

  statement {
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "autoscaling.amazonaws.com",
        "ecs.amazonaws.com",
        "elasticache.amazonaws.com",
        "rds.amazonaws.com",
        "spot.amazonaws.com",
      ]
    }
  }
}

resource "aws_iam_role_policy" "terraform_iam" {
  for_each = aws_iam_role.terraform_apply

  name   = "studafy-scoped-iam-management"
  role   = each.value.id
  policy = data.aws_iam_policy_document.terraform_iam.json
}

data "aws_iam_policy_document" "plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:pull_request", "repo:${var.github_repository}:ref:refs/heads/*"]
    }
  }
}

resource "aws_iam_role" "terraform_plan" {
  name               = "studafy-terraform-plan"
  assume_role_policy = data.aws_iam_policy_document.plan_trust.json
}

resource "aws_iam_role_policy_attachment" "terraform_plan_read_only" {
  role       = aws_iam_role.terraform_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
