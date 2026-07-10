output "zone_id" {
  description = "Route 53 hosted zone ID for zone_name. Pass this to any other module that needs to add records into the same zone instead of doing its own data-source lookup — module.edge currently does its own lookup by name (see modules/edge/dns.tf); this output exists so future modules don't have to."
  value       = local.zone_id
}

output "zone_name_servers" {
  description = "Authoritative name servers Route 53 assigned zone_name. Only non-null when manage_zone is true. Compare these against the domain registrar's delegation after the terraform import described in main.tf — a mismatch means the registrar is not actually pointed at this Terraform-managed zone yet."
  value       = var.manage_zone ? aws_route53_zone.this[0].name_servers : null
}

output "ses_domain_identity_arn" {
  description = "ARN of the verified SES domain identity. Grant ses:SendEmail/ses:SendRawEmail scoped to this ARN on whatever role ends up sending transactional mail (e.g. apps/workers' notifications queue). Null when create_email_records is false."
  value       = var.create_email_records ? aws_ses_domain_identity.this[0].arn : null
}

output "ses_mail_from_domain" {
  description = "Custom MAIL FROM domain (mail_from_subdomain.ses_domain) — the envelope-from/Return-Path address transactional email must be sent through for SPF alignment to hold. Null when create_email_records is false."
  value       = var.create_email_records ? aws_ses_domain_mail_from.this[0].mail_from_domain : null
}
