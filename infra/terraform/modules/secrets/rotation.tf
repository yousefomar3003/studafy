data "aws_region" "current" {}
data "aws_partition" "current" {}

# AWS's own single-user RDS-Postgres rotation function, deployed via the Serverless Application
# Repository rather than hand-written: reimplementing the create/set/test/finish-secret rotation
# state machine (https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_how.html)
# in a bespoke Lambda would duplicate logic AWS already publishes and maintains — the same
# KISS/DRY reasoning modules/pgbouncer used to reject standing up ACM Private CA instead of a
# self-signed cert. `functionName`/`endpoint`/`vpcSecurityGroupIds`/`vpcSubnetIds` are this SAR
# app's long-published, documented parameter contract (also this exact app in the Terraform AWS
# provider's own official example for this resource), not a guess — but this module was written
# without an AWS account to apply it against (same honesty gap as modules/pgbouncer's `dnf install`
# and modules/registry's untested cosign flow). See docs/runbooks/secrets-conventions.md's
# rotation runbook for what to check if the first real apply doesn't go cleanly.
resource "aws_serverlessapplicationrepository_cloudformation_stack" "postgres_rotation" {
  name           = "${var.name_prefix}-postgres-rotation"
  application_id = "arn:${data.aws_partition.current.partition}:serverlessrepo:us-east-1:297356227824:applications/SecretsManagerRDSPostgreSQLRotationSingleUser"

  # CAPABILITY_RESOURCE_POLICY: the app's own template attaches a resource-based policy to the
  # Lambda function granting secretsmanager.amazonaws.com permission to invoke it — CloudFormation
  # refuses to create that without this capability being explicitly acknowledged. No separate
  # aws_lambda_permission resource is declared here for the same reason: it would either duplicate
  # (harmless) or collide with (fatal) the statement the app's own template already creates.
  capabilities = ["CAPABILITY_IAM", "CAPABILITY_RESOURCE_POLICY"]

  parameters = {
    functionName = "${var.name_prefix}-postgres-rotation"
    endpoint     = "https://secretsmanager.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"
    # CloudFormation List<...>-typed parameters take a single comma-delimited string, not a list —
    # true for every List<AWS::EC2::*::Id> parameter regardless of which app declares it.
    vpcSubnetIds        = join(",", var.vpc_subnet_ids)
    vpcSecurityGroupIds = join(",", var.security_group_ids)
  }
}

# Single-user strategy (matching the SAR app name): the rotation Lambda updates the same
# studafy_admin row's password in place, rather than cloning a second user the way an
# alternating-users strategy would. Appropriate today because no second, less-privileged Postgres
# role exists yet for an alternating-users rotation to clone between
# (docs/runbooks/postgres-conventions.md's "Known gaps") — revisit once one does; alternating-users
# rotation has no connection-refused window during the swap, single-user briefly does.
resource "aws_secretsmanager_secret_rotation" "postgres" {
  secret_id           = var.postgres_connection_secret_arn
  rotation_lambda_arn = aws_serverlessapplicationrepository_cloudformation_stack.postgres_rotation.outputs["RotationLambdaARN"]

  rotation_rules {
    automatically_after_days = var.postgres_rotation_days
  }

  # Explicit, not just relying on the provider's own default: enabling this resource rotates the
  # secret once immediately, which is also the dev acceptance criterion ("DB credential rotation
  # runbook executed once in dev") — the first `terraform apply` that adds this resource in dev
  # *is* that first rotation. See docs/runbooks/secrets-conventions.md for what to verify
  # afterwards and modules/postgres/main.tf's lifecycle.ignore_changes note on why Terraform must
  # stop being the source of truth for that secret's value once this resource exists.
  rotate_immediately = true
}
