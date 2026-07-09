# Every group here is declared with zero inline ingress/egress blocks. Terraform
# revokes AWS's auto-created "allow all outbound" rule the moment a security group is
# created, regardless of how many rules get attached afterwards — so an SG with no
# rules attached below (db, redis) ends up permitting nothing at all, in or out.
#
# Rules are standalone aws_vpc_security_group_{ingress,egress}_rule resources rather
# than inline blocks. Inline egress on the ALB group referencing the app group's id,
# and inline ingress on the app group referencing the ALB group's id, would form a
# dependency cycle between the two resources; standalone rule resources attach after
# both groups exist, so cross-references between security groups are unproblematic.

# --- Load balancer: the only group with ingress from the public internet -----------

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "Load balancer: public HTTP/HTTPS ingress, forwards to the app tier only."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-alb" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_public" {
  for_each = {
    for pair in setproduct([80, 443], var.alb_ingress_cidrs) :
    "${pair[0]}-${pair[1]}" => { port = pair[0], cidr = pair[1] }
  }

  security_group_id = aws_security_group.alb.id
  description       = "Public ingress on port ${each.value.port}"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  for_each = toset([for p in var.app_ports : tostring(p)])

  security_group_id            = aws_security_group.alb.id
  description                  = "To the app tier, port ${each.value}"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.value)
  to_port                      = tonumber(each.value)
  referenced_security_group_id = aws_security_group.app.id
}

# --- App tier: reachable only from the ALB ------------------------------------------

resource "aws_security_group" "app" {
  name_prefix = "${var.name_prefix}-app-"
  description = "App tier: reachable only from the load balancer."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-app" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  for_each = toset([for p in var.app_ports : tostring(p)])

  security_group_id            = aws_security_group.app.id
  description                  = "From the load balancer, port ${each.value}"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.value)
  to_port                      = tonumber(each.value)
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  description                  = "To the database"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "app_to_redis" {
  security_group_id            = aws_security_group.app.id
  description                  = "To Redis"
  ip_protocol                  = "tcp"
  from_port                    = var.redis_port
  to_port                      = var.redis_port
  referenced_security_group_id = aws_security_group.redis.id
}

# HTTPS egress for outbound API calls. Security groups filter by IP, not domain name,
# so this is the coarsest control point available here — narrow app_egress_cidr_blocks
# once third-party providers are chosen. Domain-level egress filtering needs a proxy
# or AWS Network Firewall, which is out of scope for this module.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  for_each = toset(var.app_egress_cidr_blocks)

  security_group_id = aws_security_group.app.id
  description       = "HTTPS to required external endpoints"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "app_dns_tcp" {
  security_group_id = aws_security_group.app.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "app_dns_udp" {
  security_group_id = aws_security_group.app.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

# --- Database: reachable only from the app tier and the bastion --------------------

resource "aws_security_group" "db" {
  name_prefix = "${var.name_prefix}-db-"
  description = "Database: reachable only from the app tier and the bastion. No egress."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-db" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "From the app tier"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_bastion" {
  security_group_id            = aws_security_group.db.id
  description                  = "From the bastion"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.bastion.id
}

# --- Redis: reachable only from the app tier and the bastion -----------------------

resource "aws_security_group" "redis" {
  name_prefix = "${var.name_prefix}-redis-"
  description = "Redis: reachable only from the app tier and the bastion. No egress."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-redis" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.redis.id
  description                  = "From the app tier"
  ip_protocol                  = "tcp"
  from_port                    = var.redis_port
  to_port                      = var.redis_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_bastion" {
  security_group_id            = aws_security_group.redis.id
  description                  = "From the bastion"
  ip_protocol                  = "tcp"
  from_port                    = var.redis_port
  to_port                      = var.redis_port
  referenced_security_group_id = aws_security_group.bastion.id
}

# --- Bastion: audited SSH jump host for DB/Redis administration --------------------

resource "aws_security_group" "bastion" {
  name_prefix = "${var.name_prefix}-bastion-"
  description = "Bastion: audited SSH access to the database and Redis, from an explicit CIDR allowlist only."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-bastion" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "bastion_ssh" {
  for_each = toset(var.bastion_allowed_ssh_cidrs)

  security_group_id = aws_security_group.bastion.id
  description       = "Audited SSH"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "bastion_to_db" {
  security_group_id            = aws_security_group.bastion.id
  description                  = "To the database, for administration"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "bastion_to_redis" {
  security_group_id            = aws_security_group.bastion.id
  description                  = "To Redis, for administration"
  ip_protocol                  = "tcp"
  from_port                    = var.redis_port
  to_port                      = var.redis_port
  referenced_security_group_id = aws_security_group.redis.id
}

resource "aws_vpc_security_group_egress_rule" "bastion_https" {
  security_group_id = aws_security_group.bastion.id
  description       = "HTTPS for OS package updates and the CloudWatch Logs agent"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "bastion_dns_tcp" {
  security_group_id = aws_security_group.bastion.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "bastion_dns_udp" {
  security_group_id = aws_security_group.bastion.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}
