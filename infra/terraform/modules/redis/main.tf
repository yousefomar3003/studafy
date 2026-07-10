# Redis 7 HA pair (one primary + one replica, automatic cross-AZ failover) plus its AUTH
# token in Secrets Manager. "Pair" is fixed at 2 cache clusters by design, not a variable
# defaulted to 2 — this module provisions exactly the topology it's named for. A cluster-mode
# or 3+-node topology is a different module, not a hidden option here.
#
# Cache vs. queue traffic is separated by logical DB (0 = cache, 1 = queues), not by
# provisioning two replication groups. That's a deliberate limit, not an oversight: Redis'
# maxmemory-policy is a server-wide setting with no per-logical-DB override, so one HA pair
# can only ever have one eviction policy. It is set to noeviction instance-wide because that's
# the non-negotiable requirement for the queue workload (BullMQ job data must never be evicted
# under memory pressure, or job state corrupts) — the cache DB inherits the same policy and
# relies on application-set TTLs rather than AWS-managed LRU eviction. Full rationale and the
# operational consequences for callers: ../../../../docs/runbooks/redis-conventions.md.

resource "random_password" "auth_token" {
  # ElastiCache AUTH tokens: 16-128 chars, and reject most punctuation. Alphanumeric-only
  # stays inside that allowed set without needing to enumerate which symbols are permitted.
  length  = 32
  special = false
}

resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name_prefix}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name_prefix}-redis"
  description = "Redis 7 HA pair for ${var.name_prefix}: logical db 0 = cache, db 1 = queues."

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = var.port

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name    = var.subnet_group_name
  security_group_ids   = var.security_group_ids
  parameter_group_name = aws_elasticache_parameter_group.this.name

  # TLS is required, not merely offered: this is a new deployment with nothing already
  # connecting in plaintext to migrate (infra/terraform/README.md: "the baseline provisions
  # nothing"), so there is no transitional reason to allow a non-TLS connection.
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  at_rest_encryption_enabled = true
  auth_token                 = random_password.auth_token.result

  auto_minor_version_upgrade = var.auto_minor_version_upgrade
  snapshot_retention_limit   = var.snapshot_retention_limit
  snapshot_window            = var.snapshot_window
  maintenance_window         = var.maintenance_window
  apply_immediately          = var.apply_immediately
}

# One secret holds everything a caller needs to connect — apps read it once via
# secretsmanager:GetSecretValue rather than assembling a connection string from several
# Terraform outputs. The AUTH token never appears in a `terraform output`.
resource "aws_secretsmanager_secret" "redis" {
  name        = "${var.name_prefix}-redis-auth"
  description = "Redis AUTH token and connection info for ${var.name_prefix}. Read at runtime; never committed to *.tfvars."
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    auth_token       = random_password.auth_token.result
    primary_endpoint = aws_elasticache_replication_group.this.primary_endpoint_address
    reader_endpoint  = aws_elasticache_replication_group.this.reader_endpoint_address
    port             = var.port
    tls              = true
    cache_db         = local.cache_db_index
    queue_db         = local.queue_db_index
  })
}

locals {
  cache_db_index = 0
  queue_db_index = 1
}
