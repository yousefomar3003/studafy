# Per-service application-secret containers. This module has no opinion on modules/postgres's,
# modules/redis's or modules/pgbouncer's own secrets — each of those already owns and writes its
# own connection secret (one secret per data-tier resource, established by ../postgres, ../redis
# and ../pgbouncer). This module only composes read access to those (iam.tf) and owns a distinct,
# new category: a service's *own* application-level secret, e.g. apps/realtime's WS_JWT_SECRET
# (apps/realtime/src/env.ts), which currently defaults to an insecure placeholder value and has no
# home in Secrets Manager at all.
#
# One container per var.services key, at "${name_prefix}/<service>/app-secrets" — a canonical,
# predictable path so a future compute module (or an operator with the AWS CLI) never has to
# guess a secret's name from a resource's generated ID, the same "one secret, fetched at runtime"
# convention ../postgres, ../redis and ../pgbouncer already use, just keyed by service instead of
# by data-tier resource.
resource "aws_secretsmanager_secret" "app" {
  for_each = var.services

  name        = "${var.name_prefix}/${each.key}/app-secrets"
  description = "Application-level secrets for the ${each.key} service (${var.name_prefix}). Read at runtime; never committed to *.tfvars."
}

# Written even for a service with no entry in var.app_secret_values, as an empty JSON object — the
# container (and the IAM policy scoped to it, iam.tf) exists the moment this module is applied, so
# a future compute module's task role can be granted read access before an operator has populated
# a real value. An empty secret is a visible "nothing set yet", not a missing resource.
#
# No lifecycle.ignore_changes here (contrast rotation.tf's note on modules/postgres's own secret
# version): nothing outside Terraform ever writes to these — there is no rotation Lambda for
# application secrets, only for the Postgres master credential — so Terraform remains the sole
# source of truth. An operator updates a value by re-supplying TF_VAR_secrets_app_secret_values
# and re-applying, not by calling `aws secretsmanager put-secret-value` out of band.
resource "aws_secretsmanager_secret_version" "app" {
  for_each = var.services

  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = jsonencode(lookup(var.app_secret_values, each.key, {}))
}
