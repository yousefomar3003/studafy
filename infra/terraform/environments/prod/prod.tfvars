# Environment-specific inputs for the prod overlay. Non-secret by construction:
# secrets are supplied via TF_VAR_* environment variables or a secrets manager,
# never committed here. See infra/terraform/README.md.
#
# bastion_allowed_ssh_cidrs and bastion_key_name are deliberately absent: supply them
# via TF_VAR_bastion_allowed_ssh_cidrs / TF_VAR_bastion_key_name (see variables.tf).

environment = "prod"
aws_region  = "eu-central-1"

# Non-overlapping with dev (10.0.0.0/16) and staging (10.1.0.0/16) so the VPCs can be
# peered later without renumbering.
vpc_cidr = "10.2.0.0/16"

az_count           = 3
single_nat_gateway = false # one NAT gateway per AZ: no single point of failure in prod

postgres_instance_class = "db.r7g.large"
redis_node_type         = "cache.r7g.large"
pgbouncer_instance_type = "t3.medium"
mariadb_instance_class  = "db.m7g.large"

# Placeholder, not a researched/confirmed domain: apps/web has no hosting decision recorded
# anywhere in this repo (unlike apps/mobile, which already hardcodes api.studafy.com). Named
# by analogy with that host. Update before this environment's first real deploy.
web_origin = "https://app.studafy.com"

# Not a guess: apps/mobile/lib/src/core/config/app_environment.dart already hardcodes this exact
# host as the prod API base URL. edge_domain_name here just gives Terraform the same value the
# mobile app already assumes exists.
edge_domain_name = "api.studafy.com"

# Same host as web_origin above — module.cdn serves the exact frontend web_origin points at.
# Kept as an explicit value rather than parsed out of web_origin (see variables.tf's
# cdn_domain_name), matching the edge_domain_name / web_origin split already in this file.
cdn_domain_name = "app.studafy.com"

# ALB shouldn't disappear from a stray `terraform destroy`/console click in prod.
edge_enable_deletion_protection = true

# Nor should the CDN distribution.
cdn_enable_deletion_protection = true

# Postgres shouldn't disappear from a stray `terraform destroy`/console click either, and
# destroy should leave a recoverable snapshot behind instead of discarding data outright.
postgres_deletion_protection = true
postgres_skip_final_snapshot = false

# Same reasoning, same protection, for the ERPNext plane's MariaDB instance.
mariadb_deletion_protection = true
mariadb_skip_final_snapshot = false

# Same WebSocket-idle-connection reasoning as staging.tfvars.
edge_idle_timeout = 3600

# prod is the sole owner of the studafy.com hosted zone (module.dns) — dev/staging only read it
# via a data lookup, same as module.edge already did before this zone was Terraform-managed. If
# studafy.com already resolves today (created by hand, pre-Terraform), see
# modules/dns/README.md's import note before the first apply of this flag.
# prod is the only environment with a transactional-email requirement recorded anywhere in this
# repo so far (apps/workers/docs/queue-catalog.md's `notifications` queue is not yet wired to a
# sender). mail.studafy.com is a placeholder subdomain, not a confirmed name — update it if a
# different sending subdomain is chosen before this is first applied for real.
dns_create_email_records = true
dns_ses_domain           = "send.studafy.com"

# Placeholder: no mail-receiving infrastructure exists anywhere in this repo yet, so this address
# does not resolve to a real inbox today. Point it at wherever DMARC aggregate reports should
# actually land (a shared inbox, or a DMARC report analyzer's ingestion address) before relying
# on the "DMARC reports received" acceptance criterion.
dns_dmarc_rua = "mailto:dmarc-reports@studafy.com"
