# Internet-facing ALB: TLS termination, HTTP->HTTPS redirect, and the attach point for the
# WAFv2 web ACL in waf.tf. Sits in module.network's public subnets, behind the alb security
# group module.network already created (ingress scoped to alb_ingress_cidrs on 80/443, egress
# scoped to app_ports) — this module does not open a second hole in the network for itself.
#
# No target group is created here. No compute tier exists yet in this repo (see
# infra/terraform/README.md's status note), so there is nothing to forward to and no routing
# contract (which path goes to apps/api vs. apps/realtime) has been decided. Wiring that is a
# separate, compute-tier-scoped ticket: it attaches aws_lb_target_group + aws_lb_listener_rule
# resources to https_listener_arn (output below) without needing to modify this module. Until
# then the HTTPS listener's default action is a fixed 404 — enough to point a TLS scanner and a
# WAF payload test at, which is what this module's acceptance criteria actually require.

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids
  idle_timeout       = var.idle_timeout

  enable_deletion_protection = var.enable_deletion_protection

  # Rejects ambiguous/malformed request headers instead of forwarding them — closes off a class
  # of request-smuggling issue and is one of the checks a TLS/security scanner grades.
  drop_invalid_header_fields = true

  dynamic "access_logs" {
    for_each = var.access_logs_bucket_id == null ? [] : [1]

    content {
      bucket  = var.access_logs_bucket_id
      prefix  = var.access_logs_prefix
      enabled = true
    }
  }

  tags = { Name = "${var.name_prefix}-alb" }
}

# Acceptance criterion: "HTTP redirects to HTTPS". A fixed 301, not a forward — port 80 never
# reaches a target, so there is no plaintext path to anything behind this LB.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      status_code  = "404"
      message_body = jsonencode({ error = "no application configured" })
    }
  }
}
