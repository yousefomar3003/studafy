# MariaDB HA pair (RDS Multi-AZ, one primary + one synchronous standby, automatic failover) for
# the ERPNext + Frappe Education plane, plus its master credential and connection info in Secrets
# Manager. Structurally a straight mirror of ../postgres — same random_password/parameter-group/
# secret shape — with one deliberate difference: this instance holds no single fixed database.
# `bench new-site <school>` creates one MariaDB database *per school* at site-creation time
# (infra/deploy/scripts/erpnext-new-site.sh), not at `terraform apply` time — see README.md.

resource "random_password" "master" {
  # RDS master passwords: 8-128 chars, and MariaDB additionally rejects "/", "'", '"' and "@" —
  # excluding those from override_special (rather than special = false) keeps a large printable
  # symbol set, same approach as modules/postgres's own random_password.master.
  length           = 32
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name_prefix}-mariadb1011"
  family = "mariadb10.11"

  parameter {
    name         = "require_secure_transport"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "max_statement_time"
    value        = tostring(var.max_statement_time_seconds)
    apply_method = "immediate"
  }

  parameter {
    name         = "slow_query_log"
    value        = "1"
    apply_method = "immediate"
  }

  parameter {
    name         = "long_query_time"
    value        = tostring(var.slow_query_log_threshold_seconds)
    apply_method = "immediate"
  }

  parameter {
    name         = "general_log"
    value        = "0"
    apply_method = "immediate"
  }
}

resource "aws_db_instance" "this" {
  identifier = "${var.name_prefix}-mariadb"

  engine         = "mariadb"
  engine_version = var.engine_version
  instance_class = var.instance_class
  port           = var.port

  # No db_name: unlike modules/postgres's single shared "studafy" database, this instance holds
  # one database per school, created by `bench new-site` after apply — there is no meaningful
  # single initial database to declare here.
  username = var.master_username
  password = random_password.master.result

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = var.db_subnet_group_name
  vpc_security_group_ids = var.security_group_ids
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  multi_az = true

  backup_retention_period = var.backup_retention_days
  backup_window           = var.backup_window
  maintenance_window      = var.maintenance_window
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade = var.auto_minor_version_upgrade
  apply_immediately          = var.apply_immediately
  deletion_protection        = var.deletion_protection

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name_prefix}-mariadb-final"
}

# One secret holds everything a caller needs to connect — modules/erpnext's ECS tasks read it once
# via secretsmanager:GetSecretValue rather than assembling a connection string from several
# Terraform outputs. The master password never appears in a `terraform output`.
resource "aws_secretsmanager_secret" "mariadb" {
  name        = "${var.name_prefix}-mariadb-connection"
  description = "MariaDB master credential and connection info for the ERPNext plane (${var.name_prefix}). Read at runtime; never committed to *.tfvars."
}

resource "aws_secretsmanager_secret_version" "mariadb" {
  secret_id = aws_secretsmanager_secret.mariadb.id
  secret_string = jsonencode({
    engine   = "mariadb"
    host     = aws_db_instance.this.address
    port     = var.port
    username = var.master_username
    password = random_password.master.result
    tls      = true
  })

  # No rotation is attached to this secret (see README.md's "Known gaps") — nothing outside
  # Terraform writes to it, so unlike modules/postgres's own secret this doesn't strictly need
  # ignore_changes yet. Kept anyway, matching modules/postgres's exact convention, so attaching
  # rotation later is a pure addition rather than also requiring this lifecycle block to be added
  # retroactively.
  lifecycle {
    ignore_changes = [secret_string]
  }
}
