# Regional WAFv2 web ACL, associated with the ALB. Three kinds of rule:
#
#   1. An optional IP-based allow rule (priority 1, so it's evaluated before anything else) for an
#      authorized penetration test's source CIDRs. WAFv2 rules run in priority order and a
#      terminating action (allow/block) on an earlier rule wins outright — a match here exits
#      evaluation before the managed rule groups or rate limits ever run. Empty allow-list by
#      default: zero resources created, zero behavior change. See pentest_allowed_cidrs.
#   2. AWS managed rule groups (OWASP core rule set + the dedicated SQLi set) — these are what
#      block the SQLi/XSS test payloads in the acceptance criteria. AWSManagedRulesCommonRuleSet
#      IS AWS's OWASP Core Rule Set implementation (that's its literal description in the AWS
#      docs, not an approximation of one); it already carries baseline SQLi/XSS coverage.
#      AWSManagedRulesSQLiRuleSet is layered on top because AWS's own guidance is that CRS alone
#      under-catches SQLi compared to pairing it with the dedicated set.
#   3. Two rate-based rules scoped to /auth and /schools/register specifically, per the ticket —
#      not a blanket rate limit across every path, which would be a different, blunter control.

resource "aws_wafv2_ip_set" "pentest_allowed" {
  count = length(var.pentest_allowed_cidrs) > 0 ? 1 : 0

  name               = "${var.name_prefix}-pentest-allowed"
  description        = "Source CIDRs exempted from WAF for an authorized penetration test's testing window. Empty outside an active engagement."
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.pentest_allowed_cidrs

  tags = { Name = "${var.name_prefix}-pentest-allowed" }
}

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name_prefix}-edge"
  description = "Edge WAF for ${var.name_prefix}: OWASP core rule set, SQLi rule set, rate limits on /auth and /schools/register."
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = length(var.pentest_allowed_cidrs) > 0 ? [1] : []

    content {
      name     = "pentest-allowlist"
      priority = 1

      action {
        allow {}
      }

      statement {
        ip_set_reference_statement {
          arn = aws_wafv2_ip_set.pentest_allowed[0].arn
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        sampled_requests_enabled   = true
        metric_name                = "${var.name_prefix}-pentest-allowlist"
      }
    }
  }

  rule {
    name     = "aws-common-rule-set"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name_prefix}-common-rule-set"
    }
  }

  rule {
    name     = "aws-sqli-rule-set"
    priority = 11

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name_prefix}-sqli-rule-set"
    }
  }

  dynamic "rule" {
    for_each = local.rate_limited_paths

    content {
      name     = "rate-limit-${rule.key}"
      priority = rule.value.priority

      action {
        block {}
      }

      statement {
        rate_based_statement {
          limit              = rule.value.limit
          aggregate_key_type = "IP"

          scope_down_statement {
            byte_match_statement {
              search_string         = rule.value.path
              positional_constraint = "STARTS_WITH"

              field_to_match {
                uri_path {}
              }

              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        sampled_requests_enabled   = true
        metric_name                = "${var.name_prefix}-rate-limit-${rule.key}"
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    sampled_requests_enabled   = true
    metric_name                = "${var.name_prefix}-edge"
  }

  tags = { Name = "${var.name_prefix}-edge" }
}

locals {
  rate_limited_paths = {
    auth = {
      path     = "/auth"
      limit    = var.auth_rate_limit
      priority = 20
    }
    schools-register = {
      path     = "/schools/register"
      limit    = var.schools_register_rate_limit
      priority = 21
    }
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# Log group name must start with "aws-waf-logs-" — a hard AWS requirement for using CloudWatch
# Logs directly as a WAF logging destination (no Kinesis Firehose in between).
resource "aws_cloudwatch_log_group" "waf" {
  count = var.enable_waf_logging ? 1 : 0

  name              = "aws-waf-logs-${var.name_prefix}-edge"
  retention_in_days = var.waf_log_retention_days

  tags = { Name = "${var.name_prefix}-edge-waf" }
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  count = var.enable_waf_logging ? 1 : 0

  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]
}
