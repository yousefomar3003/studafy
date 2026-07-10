# Postgres 16 HA pair (one primary + one synchronous Multi-AZ standby, automatic failover)
# plus its master credential and connection info in Secrets Manager. "Pair" is fixed by
# multi_az = true, not a variable defaulted to true — this module provisions exactly the
# topology it's named for, same convention as ../redis (num_cache_clusters fixed at 2).
# The standby is not readable (this is RDS Multi-AZ with a standby, not a Multi-AZ DB
# cluster with readable replicas) — its only job is to take over on failover.
#
# pgvector needs no extra provisioning: AWS's Postgres 16 extension allowlist already
# includes it, so `CREATE EXTENSION vector;` works against any database created here.
# Terraform has no SQL access to run that statement itself (same limit noted in
# ../redis/README.md for verifying TLS) — see docs/runbooks/postgres-conventions.md for
# the one-time step an operator runs after the instance exists.

resource "random_password" "master" {
  # RDS master passwords: 8-128 chars, and reject "/", "@", '"', and space. Excluding those
  # four from override_special (rather than special = false) keeps a large printable symbol
  # set without needing to enumerate which symbols are permitted.
  length           = 32
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name_prefix}-postgres16"
  family = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "statement_timeout"
    value        = tostring(var.statement_timeout_ms)
    apply_method = "immediate"
  }

  parameter {
    name         = "log_min_duration_statement"
    value        = tostring(var.log_min_duration_statement_ms)
    apply_method = "immediate"
  }

  parameter {
    name         = "log_connections"
    value        = "1"
    apply_method = "immediate"
  }

  parameter {
    name         = "log_disconnections"
    value        = "1"
    apply_method = "immediate"
  }

  parameter {
    name         = "log_lock_waits"
    value        = "1"
    apply_method = "immediate"
  }
}

resource "aws_db_instance" "this" {
  identifier = "${var.name_prefix}-postgres"

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  port           = var.port

  db_name  = var.database_name
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
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name_prefix}-postgres-final"
}

# One secret holds everything a caller needs to connect — apps read it once via
# secretsmanager:GetSecretValue rather than assembling a connection string from several
# Terraform outputs. The master password never appears in a `terraform output`.
resource "aws_secretsmanager_secret" "postgres" {
  name        = "${var.name_prefix}-postgres-connection"
  description = "Postgres master credential and connection info for ${var.name_prefix}. Read at runtime; never committed to *.tfvars."
}

resource "aws_secretsmanager_secret_version" "postgres" {
  secret_id = aws_secretsmanager_secret.postgres.id
  secret_string = jsonencode({
    # "engine" isn't consumed by any caller in this repo today — it exists solely because
    # modules/secrets's rotation Lambda (AWS's published SecretsManagerRDSPostgreSQLRotationSingleUser)
    # requires it in exactly this shape and raises KeyError without it:
    # https://github.com/aws-samples/aws-secrets-manager-rotation-lambdas/blob/master/SecretsManagerRDSPostgreSQLRotationSingleUser/lambda_function.py
    engine   = "postgres"
    host     = aws_db_instance.this.address
    port     = var.port
    dbname   = var.database_name
    username = var.master_username
    password = random_password.master.result
    sslmode  = "require"
  })

  # Seeds the secret's first version only. Once modules/secrets attaches rotation
  # (aws_secretsmanager_secret_rotation) to this secret's ARN, AWS's published rotation Lambda
  # calls PutSecretValue directly against the live database — a write this resource has no way to
  # observe. Without ignore_changes, the next `terraform apply` would see secret_string still
  # equal to random_password.master.result (Terraform state never learns about the Lambda's own
  # write) and silently overwrite the rotated password back to the original one, locking out every
  # connection using the current credential. See docs/runbooks/secrets-conventions.md.
  lifecycle {
    ignore_changes = [secret_string]
  }
}
