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

resource "aws_vpc_security_group_ingress_rule" "app_from_monitoring" {
  security_group_id            = aws_security_group.app.id
  description                  = "From the monitoring plane, Prometheus scraping /metrics (ST-259)"
  ip_protocol                  = "tcp"
  from_port                    = var.metrics_port
  to_port                      = var.metrics_port
  referenced_security_group_id = aws_security_group.monitoring.id
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

# Additive, not a replacement for app_to_db: PgBouncer transaction-pooling mode is where the app
# tier's runtime traffic is meant to go (see modules/pgbouncer), but transaction mode itself is
# hostile to session-scoped operations — CREATE INDEX CONCURRENTLY, LISTEN/NOTIFY, prepared
# statements, advisory locks held across statements — so migration/admin tooling running from the
# app tier still needs the direct path to the database that app_to_db/db_from_app already provide.
# Removing those rules the moment a pooler exists would just break that tooling; see
# docs/runbooks/pgbouncer-conventions.md for which operations belong on which path.
resource "aws_vpc_security_group_egress_rule" "app_to_pgbouncer" {
  security_group_id            = aws_security_group.app.id
  description                  = "To PgBouncer"
  ip_protocol                  = "tcp"
  from_port                    = var.pgbouncer_port
  to_port                      = var.pgbouncer_port
  referenced_security_group_id = aws_security_group.pgbouncer.id
}

# apps/api is the integration gateway to the ERPNext plane — the only caller the erpnext security
# group's ingress rule (below) allows in. No other member of the app tier calls ERPNext today, but
# the rule is scoped to the whole app SG (not a narrower apps/api-only group) because this module
# has never split app-tier compute by service — see app_ports' own per-service port list for the
# same convention.
resource "aws_vpc_security_group_egress_rule" "app_to_erpnext" {
  security_group_id            = aws_security_group.app.id
  description                  = "To the ERPNext plane (apps/api is the integration gateway)"
  ip_protocol                  = "tcp"
  from_port                    = var.erpnext_port
  to_port                      = var.erpnext_port
  referenced_security_group_id = aws_security_group.erpnext.id
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

resource "aws_vpc_security_group_ingress_rule" "db_from_monitoring" {
  security_group_id            = aws_security_group.db.id
  description                  = "From the monitoring plane (postgres_exporter, ST-259)"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_bastion" {
  security_group_id            = aws_security_group.db.id
  description                  = "From the bastion"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.bastion.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_pgbouncer" {
  security_group_id            = aws_security_group.db.id
  description                  = "From PgBouncer"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.pgbouncer.id
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

# The ERPNext plane reuses this Redis pair (separate logical DBs for its cache/queue, not a second
# cluster — see docs/runbooks/redis-conventions.md's DB-assignment table), so it needs the same
# ingress the app tier already has.
resource "aws_vpc_security_group_ingress_rule" "redis_from_erpnext" {
  security_group_id            = aws_security_group.redis.id
  description                  = "From the ERPNext plane"
  ip_protocol                  = "tcp"
  from_port                    = var.redis_port
  to_port                      = var.redis_port
  referenced_security_group_id = aws_security_group.erpnext.id
}

# --- PgBouncer: reachable only from the app tier and the bastion; egresses to the db group --

resource "aws_security_group" "pgbouncer" {
  name_prefix = "${var.name_prefix}-pgbouncer-"
  description = "PgBouncer: reachable only from the app tier and the bastion. Egresses to the database only."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-pgbouncer" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "pgbouncer_from_app" {
  security_group_id            = aws_security_group.pgbouncer.id
  description                  = "From the app tier"
  ip_protocol                  = "tcp"
  from_port                    = var.pgbouncer_port
  to_port                      = var.pgbouncer_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "pgbouncer_from_bastion" {
  security_group_id            = aws_security_group.pgbouncer.id
  description                  = "From the bastion, for admin-console troubleshooting (SHOW POOLS/STATS)"
  ip_protocol                  = "tcp"
  from_port                    = var.pgbouncer_port
  to_port                      = var.pgbouncer_port
  referenced_security_group_id = aws_security_group.bastion.id
}

resource "aws_vpc_security_group_egress_rule" "pgbouncer_to_db" {
  security_group_id            = aws_security_group.pgbouncer.id
  description                  = "To the database"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.db.id
}

# HTTPS egress for the instance's own bootstrap: Secrets Manager (TLS cert + Postgres
# credential), CloudWatch (PutMetricData for pool-saturation metrics), and OS package installs.
# Same coarse IP-based control point as app_https above — not narrowed to AWS's published IP
# ranges, since VPC endpoints for these services are out of scope for this module.
resource "aws_vpc_security_group_egress_rule" "pgbouncer_https" {
  security_group_id = aws_security_group.pgbouncer.id
  description       = "HTTPS to Secrets Manager, CloudWatch and package repositories"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "pgbouncer_dns_tcp" {
  security_group_id = aws_security_group.pgbouncer.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "pgbouncer_dns_udp" {
  security_group_id = aws_security_group.pgbouncer.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

# --- Secrets rotation: the RDS rotation Lambda (modules/secrets) -------------------

resource "aws_security_group" "secrets_rotation" {
  name_prefix = "${var.name_prefix}-secrets-rotation-"
  description = "Secrets rotation Lambda (modules/secrets): egresses to the database and Secrets Manager only."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-secrets-rotation" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "secrets_rotation_to_db" {
  security_group_id            = aws_security_group.secrets_rotation.id
  description                  = "To the database, to set the rotated password"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_secrets_rotation" {
  security_group_id            = aws_security_group.db.id
  description                  = "From the secrets-rotation Lambda"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.secrets_rotation.id
}

# HTTPS egress for the Lambda's own calls back to the Secrets Manager API (GetSecretValue,
# PutSecretValue, UpdateSecretVersionStage — the create/set/test/finish-secret rotation steps). A
# VPC-attached Lambda's AWS API calls route through its ENI like any other traffic in the subnet,
# not around it — this is not optional networking, it's how the rotation Lambda reaches
# Secrets Manager at all. Same coarse IP-based control point as modules/pgbouncer's own
# pgbouncer_https rule.
resource "aws_vpc_security_group_egress_rule" "secrets_rotation_https" {
  security_group_id = aws_security_group.secrets_rotation.id
  description       = "HTTPS to the Secrets Manager API"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "secrets_rotation_dns_tcp" {
  security_group_id = aws_security_group.secrets_rotation.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "secrets_rotation_dns_udp" {
  security_group_id = aws_security_group.secrets_rotation.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

# --- MariaDB (ERPNext plane): reachable only from the erpnext tier and the bastion -------

resource "aws_security_group" "mariadb" {
  name_prefix = "${var.name_prefix}-mariadb-"
  description = "MariaDB (ERPNext plane): reachable only from the erpnext tier and the bastion. No egress."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-mariadb" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "mariadb_from_erpnext" {
  security_group_id            = aws_security_group.mariadb.id
  description                  = "From the ERPNext plane"
  ip_protocol                  = "tcp"
  from_port                    = var.mariadb_port
  to_port                      = var.mariadb_port
  referenced_security_group_id = aws_security_group.erpnext.id
}

resource "aws_vpc_security_group_ingress_rule" "mariadb_from_monitoring" {
  security_group_id            = aws_security_group.mariadb.id
  description                  = "From the monitoring plane (mysqld_exporter, ERPNext plane only, ST-259)"
  ip_protocol                  = "tcp"
  from_port                    = var.mariadb_port
  to_port                      = var.mariadb_port
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_ingress_rule" "mariadb_from_bastion" {
  security_group_id            = aws_security_group.mariadb.id
  description                  = "From the bastion"
  ip_protocol                  = "tcp"
  from_port                    = var.mariadb_port
  to_port                      = var.mariadb_port
  referenced_security_group_id = aws_security_group.bastion.id
}

# --- ERPNext (Frappe Education plane): reachable only from the app tier ------------------

# The app tier is this group's only ingress source: apps/api is the integration gateway, and this
# rule is the actual enforcement of that — not just naming. Nothing else (not the ALB, not the
# internet, not the bastion) can reach the ERPNext frontend. modules/erpnext attaches its ECS
# tasks' ENIs to this group and reuses it as the EFS mount targets' security group too (the
# self-referencing NFS rule below), rather than this module creating a fourth group for a resource
# that shares the exact same trust boundary.
resource "aws_security_group" "erpnext" {
  name_prefix = "${var.name_prefix}-erpnext-"
  description = "ERPNext/Frappe Education plane: reachable only from the app tier (apps/api is the integration gateway)."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-erpnext" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "erpnext_from_app" {
  security_group_id            = aws_security_group.erpnext.id
  description                  = "From the app tier (the integration gateway), to the ERPNext frontend"
  ip_protocol                  = "tcp"
  from_port                    = var.erpnext_port
  to_port                      = var.erpnext_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "erpnext_nfs_self" {
  security_group_id            = aws_security_group.erpnext.id
  description                  = "NFS for the shared EFS 'sites' volume, between ERPNext tasks and their EFS mount targets"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  referenced_security_group_id = aws_security_group.erpnext.id
}

resource "aws_vpc_security_group_egress_rule" "erpnext_nfs_self" {
  security_group_id            = aws_security_group.erpnext.id
  description                  = "NFS for the shared EFS 'sites' volume, between ERPNext tasks and their EFS mount targets"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  referenced_security_group_id = aws_security_group.erpnext.id
}

resource "aws_vpc_security_group_egress_rule" "erpnext_to_mariadb" {
  security_group_id            = aws_security_group.erpnext.id
  description                  = "To MariaDB"
  ip_protocol                  = "tcp"
  from_port                    = var.mariadb_port
  to_port                      = var.mariadb_port
  referenced_security_group_id = aws_security_group.mariadb.id
}

resource "aws_vpc_security_group_egress_rule" "erpnext_to_redis" {
  security_group_id            = aws_security_group.erpnext.id
  description                  = "To Redis (erpnext cache/queue DB slots)"
  ip_protocol                  = "tcp"
  from_port                    = var.redis_port
  to_port                      = var.redis_port
  referenced_security_group_id = aws_security_group.redis.id
}

# HTTPS egress for ECR image pulls, Secrets Manager and CloudWatch Logs — same coarse IP-based
# control point as modules/pgbouncer's and the bastion's own HTTPS egress rules.
resource "aws_vpc_security_group_egress_rule" "erpnext_https" {
  security_group_id = aws_security_group.erpnext.id
  description       = "HTTPS to ECR, Secrets Manager and CloudWatch"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "erpnext_dns_tcp" {
  security_group_id = aws_security_group.erpnext.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "erpnext_dns_udp" {
  security_group_id = aws_security_group.erpnext.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

# --- Monitoring (ST-259): Prometheus, Grafana, postgres_exporter, mysqld_exporter --------------

# One shared group for the whole observability plane, the same "one group per logical plane,
# reused by every role in it" pattern modules/erpnext's own security group already uses for its
# four bench roles — Prometheus, Grafana and both exporters have an identical trust boundary
# (reachable only from the bastion; egresses to whatever they scrape), so a second group would add
# no isolation, only more rules to keep in sync.
resource "aws_security_group" "monitoring" {
  name_prefix = "${var.name_prefix}-monitoring-"
  description = "Monitoring plane (Prometheus, Grafana, postgres_exporter, mysqld_exporter): dashboards reachable only from the bastion; scrapes the app tier, db and mariadb."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-monitoring" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "monitoring_from_bastion" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "From the bastion, Grafana dashboards (SSH port-forward — see docs/runbooks/metrics-dashboard-catalog.md)"
  ip_protocol                  = "tcp"
  from_port                    = var.grafana_port
  to_port                      = var.grafana_port
  referenced_security_group_id = aws_security_group.bastion.id
}

# Self-referencing rules for east-west traffic within the monitoring plane itself: Grafana's
# Prometheus datasource (9090) and Prometheus's own scrape of both exporters (9187, 9104 — the
# postgres_exporter/mysqld_exporter upstream projects' own registered default ports). One rule per
# port rather than a collapsed range, matching this file's existing per-concern convention (e.g.
# the erpnext group's own single-purpose self-referencing NFS rule above).
resource "aws_vpc_security_group_ingress_rule" "monitoring_self_prometheus" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "Grafana to Prometheus"
  ip_protocol                  = "tcp"
  from_port                    = 9090
  to_port                      = 9090
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_ingress_rule" "monitoring_self_postgres_exporter" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "Prometheus to postgres_exporter"
  ip_protocol                  = "tcp"
  from_port                    = 9187
  to_port                      = 9187
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_ingress_rule" "monitoring_self_mysqld_exporter" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "Prometheus to mysqld_exporter (ERPNext plane only)"
  ip_protocol                  = "tcp"
  from_port                    = 9104
  to_port                      = 9104
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_egress_rule" "monitoring_to_app" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "To the app tier, scraping /metrics"
  ip_protocol                  = "tcp"
  from_port                    = var.metrics_port
  to_port                      = var.metrics_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_egress_rule" "monitoring_to_db" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "To the database (postgres_exporter)"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "monitoring_to_mariadb" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "To MariaDB (mysqld_exporter, ERPNext plane only)"
  ip_protocol                  = "tcp"
  from_port                    = var.mariadb_port
  to_port                      = var.mariadb_port
  referenced_security_group_id = aws_security_group.mariadb.id
}

# HTTPS egress for ECR image pulls, Secrets Manager, CloudWatch Logs, and Grafana's own CloudWatch
# datasource (GetMetricData/ListMetrics — see modules/monitoring's grafana.tf). Same coarse
# IP-based control point as every other group's own HTTPS egress rule in this file.
resource "aws_vpc_security_group_egress_rule" "monitoring_https" {
  security_group_id = aws_security_group.monitoring.id
  description       = "HTTPS to ECR, Secrets Manager, CloudWatch and the CloudWatch API"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "monitoring_dns_tcp" {
  security_group_id = aws_security_group.monitoring.id
  description       = "DNS to the VPC resolver (Cloud Map scrape-target discovery)"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "monitoring_dns_udp" {
  security_group_id = aws_security_group.monitoring.id
  description       = "DNS to the VPC resolver (Cloud Map scrape-target discovery)"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

# Grafana's Loki datasource (infra/docker/grafana/provisioning/datasources/datasources.yml.tpl)
# reaches Loki on var.loki_port, which the 443-only monitoring_https rule above does not cover.
resource "aws_vpc_security_group_egress_rule" "monitoring_to_loki" {
  security_group_id            = aws_security_group.monitoring.id
  description                  = "To Loki, Grafana's Loki datasource (ST-261)"
  ip_protocol                  = "tcp"
  from_port                    = var.loki_port
  to_port                      = var.loki_port
  referenced_security_group_id = aws_security_group.logging.id
}

# --- Logging plane (ST-261): Vector, Loki --------------------------------------------------------

# One shared group for the whole log-aggregation plane, same "one group per logical plane" pattern
# as the monitoring group above. Vector and Loki have the same trust boundary: Loki's HTTP API is
# reachable only from the bastion (logcli / the PII audit script over an SSH tunnel), from Grafana
# and from Vector; both egress to AWS APIs (S3, SQS, ECR, Firehose, CloudWatch) over HTTPS and to
# nothing else. Vector has no inbound listener at all — it pulls from SQS.
resource "aws_security_group" "logging" {
  name_prefix = "${var.name_prefix}-logging-"
  description = "Log-aggregation plane (Vector, Loki): Loki's API reachable only from the bastion, Grafana and Vector; HTTPS egress to AWS APIs only."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-logging" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "logging_self_loki" {
  security_group_id            = aws_security_group.logging.id
  description                  = "Vector to Loki (and Loki task-to-task if ever scaled out)"
  ip_protocol                  = "tcp"
  from_port                    = var.loki_port
  to_port                      = var.loki_port
  referenced_security_group_id = aws_security_group.logging.id
}

resource "aws_vpc_security_group_ingress_rule" "logging_from_bastion" {
  security_group_id            = aws_security_group.logging.id
  description                  = "From the bastion, Loki queries over an SSH port-forward (docs/runbooks/log-aggregation.md)"
  ip_protocol                  = "tcp"
  from_port                    = var.loki_port
  to_port                      = var.loki_port
  referenced_security_group_id = aws_security_group.bastion.id
}

resource "aws_vpc_security_group_ingress_rule" "logging_from_monitoring" {
  security_group_id            = aws_security_group.logging.id
  description                  = "From the monitoring plane, Grafana's Loki datasource"
  ip_protocol                  = "tcp"
  from_port                    = var.loki_port
  to_port                      = var.loki_port
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_egress_rule" "logging_self_loki" {
  security_group_id            = aws_security_group.logging.id
  description                  = "Vector to Loki within the plane"
  ip_protocol                  = "tcp"
  from_port                    = var.loki_port
  to_port                      = var.loki_port
  referenced_security_group_id = aws_security_group.logging.id
}

# HTTPS egress for ECR image pulls plus the pipeline's actual data path: S3 (archive + chunks +
# security buckets), SQS (the ingest queue), Firehose has no runtime call here, CloudWatch Logs
# (the awslogs driver). None of those has a security-group-referenceable endpoint, so this is the
# coarsest control point available — same as every other plane's HTTPS egress rule in this file.
resource "aws_vpc_security_group_egress_rule" "logging_https" {
  security_group_id = aws_security_group.logging.id
  description       = "HTTPS to ECR, S3, SQS and CloudWatch"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "logging_dns_tcp" {
  security_group_id = aws_security_group.logging.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "logging_dns_udp" {
  security_group_id = aws_security_group.logging.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
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

resource "aws_vpc_security_group_egress_rule" "bastion_to_pgbouncer" {
  security_group_id            = aws_security_group.bastion.id
  description                  = "To PgBouncer, for admin-console troubleshooting"
  ip_protocol                  = "tcp"
  from_port                    = var.pgbouncer_port
  to_port                      = var.pgbouncer_port
  referenced_security_group_id = aws_security_group.pgbouncer.id
}

resource "aws_vpc_security_group_egress_rule" "bastion_to_monitoring" {
  security_group_id            = aws_security_group.bastion.id
  description                  = "To Grafana, for dashboard access (SSH port-forward, ST-259)"
  ip_protocol                  = "tcp"
  from_port                    = var.grafana_port
  to_port                      = var.grafana_port
  referenced_security_group_id = aws_security_group.monitoring.id
}

resource "aws_vpc_security_group_egress_rule" "bastion_to_mariadb" {
  security_group_id            = aws_security_group.bastion.id
  description                  = "To MariaDB (ERPNext plane), for administration"
  ip_protocol                  = "tcp"
  from_port                    = var.mariadb_port
  to_port                      = var.mariadb_port
  referenced_security_group_id = aws_security_group.mariadb.id
}

resource "aws_vpc_security_group_egress_rule" "bastion_to_loki" {
  security_group_id            = aws_security_group.bastion.id
  description                  = "To Loki, for log search (SSH port-forward — logcli / the PII audit script, ST-261)"
  ip_protocol                  = "tcp"
  from_port                    = var.loki_port
  to_port                      = var.loki_port
  referenced_security_group_id = aws_security_group.logging.id
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
