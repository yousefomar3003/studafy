terraform {
  # Partial backend configuration: no values are committed here. Bucket, key and
  # region come from `environments/<env>/backend.hcl` at init time:
  #
  #   terraform init -reconfigure -backend-config=environments/<env>/backend.hcl
  #
  # Credentials are never part of that file — they resolve from the standard AWS
  # credential chain (env vars, SSO, OIDC, shared config). See README.md.
  backend "s3" {}
}
