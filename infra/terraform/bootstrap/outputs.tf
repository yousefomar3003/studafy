output "account_id" {
  value = data.aws_caller_identity.current.account_id

  precondition {
    condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
    error_message = "Refusing to bootstrap the wrong AWS account."
  }
}

output "route53_zone_id" {
  value = aws_route53_zone.studafy.zone_id
}

output "route53_name_servers" {
  value = aws_route53_zone.studafy.name_servers
}

output "github_oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}

output "terraform_plan_role_arn" {
  value = aws_iam_role.terraform_plan.arn
}

output "terraform_apply_role_arns" {
  value = { for env, role in aws_iam_role.terraform_apply : env => role.arn }
}

output "state_bucket_names" {
  value = { for scope, bucket in aws_s3_bucket.state : scope => bucket.id }
}
