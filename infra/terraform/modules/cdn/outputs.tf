output "web_bundle_bucket_id" {
  description = "Name of the private web-bundle bucket. Pass to `aws s3 sync` as the deploy target."
  value       = aws_s3_bucket.web_bundle.id
}

output "web_bundle_bucket_arn" {
  description = "ARN of the web-bundle bucket."
  value       = aws_s3_bucket.web_bundle.arn
}

output "distribution_id" {
  description = "CloudFront distribution ID. Pass to `aws cloudfront create-invalidation --distribution-id`."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "ARN of the CloudFront distribution."
  value       = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  description = "Default *.cloudfront.net domain CloudFront assigns the distribution (regardless of domain_name/DNS setup)."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "domain_name" {
  description = "Echoes var.domain_name, for callers building the public URL without re-reading *.tfvars."
  value       = var.domain_name
}

output "certificate_arn" {
  description = "ARN of the validated ACM certificate (us-east-1) bound to the distribution."
  value       = aws_acm_certificate_validation.this.certificate_arn
}

output "deploy_role_arn" {
  description = "IAM role a GitHub Actions run deploying to the module's `environment` GitHub Environment assumes to sync the web bundle and invalidate the distribution. See docs/runbooks/cdn-cache-policy.md for the exact deploy commands."
  value       = aws_iam_role.deploy.arn
}
