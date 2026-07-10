# ACM cert (DNS-validated) for domain_name, plus the Route 53 records that prove domain
# ownership to ACM and the alias record that actually points domain_name at the ALB.
#
# The zone itself is looked up, never created: domain_name is expected to already resolve
# somewhere close to this (or be a fresh subdomain of a zone that already exists), matching
# apps/mobile/lib/src/core/config/app_environment.dart's already-hardcoded api.studafy.com /
# staging-api.studafy.com. A missing zone fails the plan here with a clear "no matching
# Route 53 zone" error instead of silently provisioning nothing.

data "aws_route53_zone" "this" {
  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  tags = { Name = "${var.name_prefix}-edge" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.this.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

# Blocks until ACM sees the validation record(s) resolve — the aws_lb_listener.https below
# depends on this, not on aws_acm_certificate.this directly, so a listener is never created
# pointing at a still-pending certificate.
resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  count = var.create_dns_record ? 1 : 0

  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
