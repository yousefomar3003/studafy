output "alb_arn" {
  description = "ARN of the load balancer."
  value       = aws_lb.this.arn
}

output "alb_dns_name" {
  description = "Default DNS name AWS assigns the load balancer (regardless of domain_name/DNS setup)."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Route 53 hosted zone ID of the load balancer itself — needed to alias any other record at it besides the one this module already creates when create_dns_record is true."
  value       = aws_lb.this.zone_id
}

output "alb_security_group_id" {
  description = "Echoes the security group this ALB uses, so callers don't have to re-derive it from module.network."
  value       = var.alb_security_group_id
}

output "https_listener_arn" {
  description = "ARN of the HTTPS (443) listener. A future compute-tier module attaches aws_lb_target_group + aws_lb_listener_rule resources here to route real traffic — this module deliberately creates neither."
  value       = aws_lb_listener.https.arn
}

output "http_listener_arn" {
  description = "ARN of the HTTP (80) listener. Only a redirect-to-HTTPS action lives here; no rules should ever be attached to it."
  value       = aws_lb_listener.http.arn
}

output "certificate_arn" {
  description = "ARN of the validated ACM certificate bound to the HTTPS listener."
  value       = aws_acm_certificate_validation.this.certificate_arn
}

output "domain_name" {
  description = "Echoes domain_name, for callers building the public URL without re-reading *.tfvars."
  value       = var.domain_name
}

output "web_acl_arn" {
  description = "ARN of the WAFv2 web ACL associated with this ALB."
  value       = aws_wafv2_web_acl.this.arn
}

output "web_acl_id" {
  description = "ID of the WAFv2 web ACL, for referencing it from the AWS console/CLI."
  value       = aws_wafv2_web_acl.this.id
}

output "waf_log_group_name" {
  description = "CloudWatch Logs group WAF request logs (including every rule match/block) land in. Null if enable_waf_logging is false."
  value       = var.enable_waf_logging ? aws_cloudwatch_log_group.waf[0].name : null
}
