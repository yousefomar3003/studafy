# Read-only, and scoped per service to exactly its own app-secrets ARN plus the shared data-tier
# secrets it's declared to need (var.services[*].shared_secret_arns) — not
# secretsmanager:GetSecretValue on "*", and not one shared policy every service gets attached to.
# Same least-privilege shape as modules/pgbouncer's own aws_iam_role_policy.pgbouncer_secrets
# (scoped to exactly the two ARNs that instance needs), but a standalone aws_iam_policy here
# instead of an aws_iam_role_policy: no compute tier/task role exists yet to attach an inline
# policy to (infra/terraform/README.md's status note), so this module produces a managed policy a
# future ECS task role attaches by ARN (aws_iam_role_policy_attachment) once one exists.
data "aws_iam_policy_document" "service_secrets" {
  for_each = var.services

  statement {
    sid       = "GetSecretValue"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([aws_secretsmanager_secret.app[each.key].arn], each.value.shared_secret_arns)
  }
}

resource "aws_iam_policy" "service_secrets" {
  for_each = var.services

  name_prefix = "${var.name_prefix}-${each.key}-secrets-"
  description = "Read-only access to the ${each.key} service's own app-secrets container and the shared data-tier secrets it needs. Attach to ${each.key}'s compute task role once one exists (see docs/runbooks/secrets-conventions.md)."
  policy      = data.aws_iam_policy_document.service_secrets[each.key].json
}
