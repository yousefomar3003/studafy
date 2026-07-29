# A single self-managed EC2 instance running PgBouncer in transaction-pooling mode, the same
# minimal-compute pattern modules/network already uses for the bastion — not an ECS service or an
# Auto Scaling Group, because no compute tier (ECS or otherwise) exists anywhere in this repo yet
# (infra/terraform/README.md's status note). Unlike the app tier (which genuinely waits on a
# separate compute-tier ticket, per modules/edge's README), PgBouncer is data-tier infrastructure
# glue in the same category as the bastion: it has to exist before there's an app tier to use it,
# not after. High availability (multiple instances behind a load balancer) is out of scope for
# this ticket — see README's "What this module does not do".

data "aws_region" "current" {}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  stats_username = "pgbouncer_stats"
}

# --- PgBouncer's own admin-console credential (SHOW POOLS/STATS), distinct from the Postgres
# master user in admin_users, so the metrics scraper runs with the least privilege that lets it
# read pool state, not full pgbouncer admin rights (RELOAD, PAUSE, KILL, ...).
resource "random_password" "stats" {
  length  = 32
  special = false
}

resource "random_password" "service_client" {
  for_each = var.service_pools

  length  = 32
  special = false
}

# --- Client-facing TLS: a self-signed CA plus a leaf certificate signed by it, not ACM. ACM
# certificates' private keys are not exportable for a listener ACM doesn't itself terminate, and
# ACM Private CA is a real-money cost/complexity jump unjustified for a KISS single-instance
# pooler. Clients trust ca_cert_pem (in the secret below), not a bare self-signed leaf, so a
# future second instance's leaf can be reissued from the same CA without every client re-trusting
# a new cert.
resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem

  subject {
    common_name  = "${var.name_prefix}-pgbouncer-ca"
    organization = "Studafy"
  }

  validity_period_hours = 8760 # 1 year
  is_ca_certificate     = true

  allowed_uses = [
    "cert_signing",
    "crl_signing",
    "digital_signature",
    "key_encipherment",
  ]
}

resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem

  subject {
    common_name  = "${var.name_prefix}-pgbouncer"
    organization = "Studafy"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem   = tls_cert_request.server.cert_request_pem
  ca_private_key_pem = tls_private_key.ca.private_key_pem
  ca_cert_pem        = tls_self_signed_cert.ca.cert_pem

  validity_period_hours = 8760 # 1 year

  allowed_uses = [
    "digital_signature",
    "key_encipherment",
    "server_auth",
  ]
}

# One secret holds everything the instance needs to bootstrap and everything a client needs to
# verify it — same "one secret, fetched at runtime" convention as modules/postgres and
# modules/redis. The CA cert (not the server cert) is what callers configure as sslrootcert.
resource "aws_secretsmanager_secret" "pgbouncer" {
  name        = "${var.name_prefix}-pgbouncer-connection"
  description = "PgBouncer TLS material and admin-console credential for ${var.name_prefix}. Read at runtime; never committed to *.tfvars."
}

# Deliberately excludes the instance's private_ip (see the "private_ip" output instead): every
# value here must be known before the instance boots, because the instance's own user_data reads
# this same secret at launch to render its TLS material and userlist.txt. Including an attribute
# that only exists after the instance is created would make this secret version depend on the
# instance while the instance (via the depends_on below) depends on this secret version existing
# first — a real cycle, not just an ordering inconvenience.
resource "aws_secretsmanager_secret_version" "pgbouncer" {
  secret_id = aws_secretsmanager_secret.pgbouncer.id
  secret_string = jsonencode({
    port            = var.listen_port
    ca_cert_pem     = tls_self_signed_cert.ca.cert_pem
    server_cert_pem = tls_locally_signed_cert.server.cert_pem
    server_key_pem  = tls_private_key.server.private_key_pem
    stats_username  = local.stats_username
    stats_password  = random_password.stats.result
    sslmode         = "verify-ca"
    api_username    = "api"
    api_password    = random_password.service_client["api"].result
    service_credentials = {
      for name, password in random_password.service_client : name => password.result
    }
  })
}

resource "aws_cloudwatch_log_group" "pgbouncer" {
  name              = "/${var.name_prefix}/pgbouncer/log"
  retention_in_days = var.log_retention_days

  tags = { Name = "${var.name_prefix}-pgbouncer-log" }
}

resource "aws_iam_role" "pgbouncer" {
  name_prefix = "${var.name_prefix}-pgbouncer-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.name_prefix}-pgbouncer" }
}

# Read-only, and scoped to exactly the two secrets this instance needs — not
# secretsmanager:GetSecretValue on "*". It cannot read the Postgres master credential secret's
# sibling resources (e.g. a future Redis-adjacent secret) or anything outside its own two ARNs.
resource "aws_iam_role_policy" "pgbouncer_secrets" {
  name_prefix = "${var.name_prefix}-pgbouncer-secrets-"
  role        = aws_iam_role.pgbouncer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = [var.postgres_connection_secret_arn, aws_secretsmanager_secret.pgbouncer.arn]
    }]
  })
}

resource "aws_iam_role_policy" "pgbouncer_logs" {
  name_prefix = "${var.name_prefix}-pgbouncer-logs-"
  role        = aws_iam_role.pgbouncer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.pgbouncer.arn}:*"
    }]
  })
}

# Scoped with a namespace condition, the only resource-level restriction PutMetricData supports —
# this role cannot write metrics into any other namespace this account happens to use.
resource "aws_iam_role_policy" "pgbouncer_metrics" {
  name_prefix = "${var.name_prefix}-pgbouncer-metrics-"
  role        = aws_iam_role.pgbouncer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "cloudwatch:PutMetricData"
      Resource = "*"
      Condition = {
        StringEquals = {
          "cloudwatch:namespace" = var.cloudwatch_metrics_namespace
        }
      }
    }]
  })
}

resource "aws_iam_instance_profile" "pgbouncer" {
  name_prefix = "${var.name_prefix}-pgbouncer-"
  role        = aws_iam_role.pgbouncer.name
}

locals {
  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    aws_region               = data.aws_region.current.region
    postgres_secret_arn      = var.postgres_connection_secret_arn
    pgbouncer_secret_arn     = aws_secretsmanager_secret.pgbouncer.arn
    listen_port              = var.listen_port
    service_pools            = var.service_pools
    read_pools               = var.read_pools
    read_replica_host        = var.read_replica_host
    max_client_conn          = var.max_client_conn
    default_pool_size        = var.default_pool_size
    stats_username           = local.stats_username
    log_group_name           = aws_cloudwatch_log_group.pgbouncer.name
    cloudwatch_namespace     = var.cloudwatch_metrics_namespace
    metrics_interval_seconds = var.metrics_interval_seconds
  })
}

resource "aws_instance" "this" {
  ami                    = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = var.security_group_ids
  iam_instance_profile   = aws_iam_instance_profile.pgbouncer.name
  key_name               = var.key_name
  user_data              = local.user_data

  # Forces the secret version to exist before this instance's user_data tries to read it.
  # user_data references aws_secretsmanager_secret.pgbouncer.arn (the container), not the version,
  # so without this the container could exist while its value is still being written when boot
  # first calls get-secret-value.
  depends_on = [aws_secretsmanager_secret_version.pgbouncer]

  # IMDSv2 only — same rationale as the bastion: closes the SSRF-to-credential-theft path IMDSv1
  # allows for a role that already holds Secrets Manager read access.
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    encrypted   = true
    volume_size = var.root_volume_size_gb
  }

  tags = { Name = "${var.name_prefix}-pgbouncer" }
}
