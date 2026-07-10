# ACM cert for domain_name, plus the Route 53 records that prove domain ownership to ACM and the
# alias record that points domain_name at the CloudFront distribution. Structured the same way as
# modules/edge/dns.tf, with one difference CloudFront forces: the certificate must be requested
# against the aws.us_east_1 provider alias regardless of the stack's home region — CloudFront only
# accepts ACM certificates from us-east-1, a hard AWS constraint, not a regional preference this
# module is choosing.

data "aws_route53_zone" "this" {
  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "this" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  tags = { Name = "${var.name_prefix}-cdn" }

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

resource "aws_acm_certificate_validation" "this" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "web" {
  count = var.create_dns_record ? 1 : 0

  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name    = aws_cloudfront_distribution.this.domain_name
    zone_id = aws_cloudfront_distribution.this.hosted_zone_id
    # CloudFront distributions have no per-region health check to evaluate — every edge location
    # answers regardless of origin health (that's what custom_error_response is for). Matches AWS's
    # own guidance for aliasing to a CloudFront distribution.
    evaluate_target_health = false
  }
}
