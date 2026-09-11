variable "project" {
  description = "Project slug used as the prefix for every resource name."
  type        = string
  default     = "studafy"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.project))
    error_message = "project must be lowercase alphanumeric with hyphens, starting with a letter."
  }
}

variable "environment" {
  description = <<-EOT
    Infrastructure environment. Matches the mobile app's flavor short names
    (apps/mobile/lib/src/core/config/app_environment.dart). This is distinct from
    the services' runtime NODE_ENV (development|test|production).
  EOT
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region the environment's resources are provisioned in."
  type        = string
}

variable "extra_tags" {
  description = "Environment-specific tags merged on top of the canonical tag set."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for this environment's VPC. Kept non-overlapping across environments so they can be VPC-peered later without renumbering."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones the network module spreads subnets across (2 or 3)."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "true: one shared NAT gateway (cheaper). false: one NAT gateway per AZ (highly available)."
  type        = bool
  default     = true
}

variable "db_port" {
  description = "TCP port Postgres listens on. Shared between module.network (security group rule) and module.postgres (engine port) so the two can never drift apart — the network module's own db_port default exists only for callers that don't also provision this module."
  type        = number
  default     = 5432

  validation {
    condition     = var.db_port > 0 && var.db_port <= 65535
    error_message = "db_port must be a valid TCP port (1-65535)."
  }
}

variable "postgres_instance_class" {
  description = "RDS instance class for both members of the Postgres HA pair. db.t4g.micro is dev-appropriate only — no researched staging/prod sizing exists yet (same honesty gap as aws_region and redis_node_type above)."
  type        = string
  default     = "db.t4g.micro"
}

variable "postgres_deletion_protection" {
  description = "Whether the Postgres instance rejects deletion until this is turned off first. false by default (dev); override true in staging/prod.tfvars."
  type        = bool
  default     = false
}

variable "postgres_skip_final_snapshot" {
  description = "true: destroy takes no final snapshot (dev, disposable). false: destroy snapshots to a fixed name first (see modules/postgres/variables.tf for the re-create caveat) — set false in staging/prod.tfvars."
  type        = bool
  default     = true
}

variable "postgres_rotation_days" {
  description = "Days between automatic rotations of module.postgres's master credential via module.secrets. 30 is AWS's own commonly documented starting point for RDS rotation, not an unresearched placeholder like postgres_instance_class above."
  type        = number
  default     = 30

  validation {
    condition     = var.postgres_rotation_days >= 1
    error_message = "postgres_rotation_days must be at least 1."
  }
}

variable "secrets_app_secret_values" {
  description = <<-EOT
    Per-service application secrets (e.g. { realtime = { WS_JWT_SECRET = "..." } }), written into
    each service's Secrets Manager container by module.secrets. Deliberately has no default and
    must never be set in a *.tfvars file — supply via TF_VAR_secrets_app_secret_values, the same
    convention this README already documents for WS_JWT_SECRET/REDIS_URL. A service with no entry
    here still gets its container created, holding an empty JSON object rather than being absent —
    see modules/secrets/README.md.
  EOT
  type        = map(map(string))
  default     = {}
  sensitive   = true
}

variable "redis_port" {
  description = "TCP port Redis listens on. Shared between module.network (security group rule) and module.redis (engine port) so the two can never drift apart — the network module's own redis_port default exists only for callers that don't also provision this module."
  type        = number
  default     = 6379

  validation {
    condition     = var.redis_port > 0 && var.redis_port <= 65535
    error_message = "redis_port must be a valid TCP port (1-65535)."
  }
}

variable "redis_node_type" {
  description = "ElastiCache node type for both members of the Redis HA pair. cache.t4g.micro is dev-appropriate only — no researched staging/prod sizing exists yet (same honesty gap as aws_region above)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "pgbouncer_port" {
  description = "TCP port PgBouncer listens on. Shared between module.network (security group rule) and module.pgbouncer (listener) so the two can never drift apart — the network module's own pgbouncer_port default exists only for callers that don't also provision this module."
  type        = number
  default     = 6432

  validation {
    condition     = var.pgbouncer_port > 0 && var.pgbouncer_port <= 65535
    error_message = "pgbouncer_port must be a valid TCP port (1-65535)."
  }
}

variable "pgbouncer_instance_type" {
  description = "EC2 instance type for the PgBouncer host. t3.micro is dev-appropriate only — no researched staging/prod connection-volume sizing exists yet (same honesty gap as postgres_instance_class/redis_node_type above)."
  type        = string
  default     = "t3.micro"
}

variable "pgbouncer_key_name" {
  description = <<-EOT
    Name of an existing EC2 key pair for SSH access to the PgBouncer host via the bastion.
    Deliberately has no default — supply via TF_VAR_pgbouncer_key_name (same pattern as
    bastion_key_name); null disables SSH access entirely and leaves the shipped CloudWatch log
    and exported metrics as the only troubleshooting surface.
  EOT
  type        = string
  default     = null
}

variable "bastion_allowed_ssh_cidrs" {
  description = <<-EOT
    CIDRs allowed to SSH into this environment's bastion. Deliberately has no default —
    supply per environment via TF_VAR_bastion_allowed_ssh_cidrs, the same way application
    secrets are passed (see README.md). Not committed to *.tfvars because it is
    operator/office-specific, not a stable environment fact.
  EOT
  type        = list(string)
}

variable "bastion_key_name" {
  description = <<-EOT
    Name of an existing EC2 key pair for this environment's bastion. Supply via
    TF_VAR_bastion_key_name; not committed to *.tfvars. Create the key pair out of band
    first — Terraform does not create it (see modules/network/README.md).
  EOT
  type        = string
}

variable "edge_domain_name" {
  description = <<-EOT
    Public hostname the load balancer (module.edge) serves for this environment, e.g.
    "api.studafy.com". staging and prod values are not guesses — they match what
    apps/mobile/lib/src/core/config/app_environment.dart already hardcodes as the API base URL
    for those flavors.
  EOT
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.edge_domain_name))
    error_message = "edge_domain_name must be a bare hostname (e.g. \"api.studafy.com\"), no scheme, no path."
  }
}

variable "edge_create_dns_record" {
  description = "Whether module.edge manages the alias A record for edge_domain_name. See modules/edge/variables.tf's create_dns_record for when to set this false."
  type        = bool
  default     = true
}

variable "edge_enable_deletion_protection" {
  description = "Whether the ALB rejects deletion until this is turned off first. false by default (dev/staging); override true in prod.tfvars."
  type        = bool
  default     = false
}

variable "edge_idle_timeout" {
  description = <<-EOT
    Seconds an idle connection is kept open by the ALB before it closes it. modules/edge's own
    default (60s) is fine for plain HTTP, but apps/realtime's /ws upgrade route (module.compute's
    listener rule) now shares this same ALB — a WebSocket connection that only exchanges a
    heartbeat every few minutes would otherwise be cut mid-session. Raise this in staging/prod's
    tfvars once realtime is actually wired to the listener.
  EOT
  type        = number
  default     = 60
}

variable "edge_pentest_allowed_cidrs" {
  description = <<-EOT
    CIDRs exempted from module.edge's WAF for the duration of an authorized external
    penetration test — see docs/runbooks/security/st-250-external-pentest-commissioning.md.
    Defaults to [] (no exemption, no behavior change) and is not committed to *.tfvars with a
    non-empty value: like bastion_allowed_ssh_cidrs, a tester's source range is a per-engagement
    fact, not a stable environment one. Supply via TF_VAR_edge_pentest_allowed_cidrs only while an
    engagement's testing window is open, and apply with an explicit [] again once it closes.
  EOT
  type        = list(string)
  default     = []
}

variable "cdn_domain_name" {
  description = <<-EOT
    Public hostname module.cdn's CloudFront distribution serves the apps/web bundle at, e.g.
    "app.studafy.com" or "staging.studafy.com". Deliberately its own variable rather than parsed
    out of web_origin — matches the existing edge_domain_name / web_origin split, where two
    related-but-distinct hosts are each an explicit value. In practice this equals web_origin's
    host portion for the same environment, because module.cdn's whole purpose is serving that
    origin's static files; environments/<env>/<env>.tfvars sets both by hand rather than deriving
    one from the other. Unused when var.environment is "dev" (module.cdn is not instantiated for
    dev — see main.tf) but still required input, since root variables are evaluated regardless of
    which modules end up using them.
  EOT
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.cdn_domain_name))
    error_message = "cdn_domain_name must be a bare hostname (e.g. \"app.studafy.com\"), no scheme, no path."
  }
}

variable "cdn_enable_deletion_protection" {
  description = "Whether module.cdn's CloudFront distribution rejects deletion until this is turned off first (retain_on_delete). false by default (dev/staging); override true in prod.tfvars. Ignored when var.environment is \"dev\" (module.cdn is not instantiated there)."
  type        = bool
  default     = false
}

variable "dns_create_email_records" {
  description = "Whether module.dns provisions the SES domain identity, DKIM, custom MAIL FROM and DMARC records for dns_ses_domain. false (default) — set true where an environment actually sends transactional email (prod.tfvars)."
  type        = bool
  default     = false
}

variable "dns_ses_domain" {
  description = "Dedicated subdomain transactional email is sent from, e.g. \"mail.studafy.com\". Required whenever dns_create_email_records is true — see modules/dns/variables.tf's ses_domain for why this is never the bare apex domain itself."
  type        = string
  default     = null
}

variable "dns_mail_from_subdomain" {
  description = "Label prepended to dns_ses_domain for SES's custom MAIL FROM domain, e.g. \"bounce\" -> \"bounce.mail.studafy.com\". See modules/dns/variables.tf's mail_from_subdomain."
  type        = string
  default     = "bounce"
}

variable "dns_dmarc_policy" {
  description = "DMARC enforcement policy published for dns_ses_domain: none, quarantine or reject. This ticket's acceptance criteria call for \"quarantine\"; see modules/dns/variables.tf's dmarc_policy before tightening to \"reject\"."
  type        = string
  default     = "quarantine"
}

variable "dns_dmarc_rua" {
  description = <<-EOT
    Aggregate DMARC report destination for dns_ses_domain, as a "mailto:" URI, e.g.
    "mailto:dmarc-reports@studafy.com". Required whenever dns_create_email_records is true — see
    modules/dns/variables.tf's dmarc_rua for why this has no default.
  EOT
  type        = string
  default     = null
}

variable "dns_dmarc_ruf" {
  description = "Forensic DMARC report destination for dns_ses_domain, as a \"mailto:\" URI. null (default) omits ruf= from the record. See modules/dns/variables.tf's dmarc_ruf."
  type        = string
  default     = null
}

variable "mariadb_port" {
  description = "TCP port the ERPNext plane's MariaDB instance listens on. Shared between module.network (security group rule) and module.mariadb (engine port) so the two can never drift apart — same convention as db_port/redis_port/pgbouncer_port above."
  type        = number
  default     = 3306

  validation {
    condition     = var.mariadb_port > 0 && var.mariadb_port <= 65535
    error_message = "mariadb_port must be a valid TCP port (1-65535)."
  }
}

variable "mariadb_instance_class" {
  description = "RDS instance class for both members of the MariaDB HA pair. db.t4g.micro is dev-appropriate only — no researched staging/prod sizing exists yet, same honesty gap as postgres_instance_class."
  type        = string
  default     = "db.t4g.micro"
}

variable "mariadb_deletion_protection" {
  description = "Whether the MariaDB instance rejects deletion until this is turned off first. false by default; override true in staging/prod.tfvars."
  type        = bool
  default     = false
}

variable "mariadb_skip_final_snapshot" {
  description = "true: destroy takes no final snapshot. false: destroy snapshots to a fixed name first — set false in staging/prod.tfvars. Same re-create caveat as postgres_skip_final_snapshot."
  type        = bool
  default     = true
}

variable "erpnext_port" {
  description = "TCP port the ERPNext plane's frontend (nginx) listens on. Shared between module.network (security group rule) and module.erpnext (ALB target group / container port) so the two can never drift apart."
  type        = number
  default     = 8080

  validation {
    condition     = var.erpnext_port > 0 && var.erpnext_port <= 65535
    error_message = "erpnext_port must be a valid TCP port (1-65535)."
  }
}

variable "metrics_port" {
  description = "TCP port apps/api, apps/realtime and apps/workers each expose their Prometheus-format /metrics endpoint on (ST-259). Shared between module.network (security group rule) and module.monitoring (Prometheus scrape config) so the two can never drift apart — same convention as db_port/mariadb_port/erpnext_port above. Matches each service's own METRICS_PORT default (apps/*/src/env.ts)."
  type        = number
  default     = 9464

  validation {
    condition     = var.metrics_port > 0 && var.metrics_port <= 65535
    error_message = "metrics_port must be a valid TCP port (1-65535)."
  }
}

variable "grafana_port" {
  description = "TCP port Grafana listens on inside the monitoring security group (ST-259). Shared between module.network (security group rule) and module.monitoring (task definition) for the same reason as metrics_port above."
  type        = number
  default     = 3000

  validation {
    condition     = var.grafana_port > 0 && var.grafana_port <= 65535
    error_message = "grafana_port must be a valid TCP port (1-65535)."
  }
}

variable "alertmanager_port" {
  description = "TCP port Alertmanager serves its API and UI on (ST-262). Shared between module.network (security group rules), module.monitoring (task definition) and — as a static value — infra/docker/prometheus/prometheus.yml's `alerting` block and the CloudWatch alert bridge, for the same never-drift reason as grafana_port/metrics_port above."
  type        = number
  default     = 9093

  validation {
    condition     = var.alertmanager_port > 0 && var.alertmanager_port <= 65535
    error_message = "alertmanager_port must be a valid TCP port (1-65535)."
  }
}

variable "loki_port" {
  description = "TCP port Loki serves its HTTP API on (ST-261). Shared between module.network (security group rules), module.logging (task definition + Vector sink URL) and — as a static value — infra/docker/grafana/provisioning/datasources/datasources.yml.tpl's Loki datasource, so all four can never drift apart. Same convention as grafana_port/metrics_port above."
  type        = number
  default     = 3100

  validation {
    condition     = var.loki_port > 0 && var.loki_port <= 65535
    error_message = "loki_port must be a valid TCP port (1-65535)."
  }
}

variable "otel_collector_port" {
  description = "TCP port the OTel collector's OTLP/HTTP receiver listens on (ST-260). Shared between module.network (security group rules) and module.monitoring (task definition, apps/*'s OTEL_EXPORTER_OTLP_ENDPOINT) for the same reason as metrics_port above."
  type        = number
  default     = 4318

  validation {
    condition     = var.otel_collector_port > 0 && var.otel_collector_port <= 65535
    error_message = "otel_collector_port must be a valid TCP port (1-65535)."
  }
}

variable "erpnext_image_tag" {
  description = "Tag of module.registry's erpnext ECR repository to deploy for the backend/websocket/queue/scheduler roles. Bumping this and re-applying is how an ERPNext image update ships — see modules/erpnext/README.md's Known gaps for why there's no rolling-deploy script for this plane."
  type        = string
  default     = "latest"
}

variable "prometheus_image_tag" {
  description = "Tag of module.registry's prometheus ECR repository to deploy (ST-259). Bumping this and re-applying is how a scrape-config change (infra/docker/prometheus/prometheus.yml) ships — same rolling-deploy shape as erpnext_image_tag."
  type        = string
  default     = "latest"
}

variable "alertmanager_image_tag" {
  description = "Tag of module.registry's alertmanager ECR repository to deploy (ST-262). Bumping this and re-applying is how a routing change (infra/docker/alertmanager/alertmanager.yml) ships — same rolling-deploy shape as prometheus_image_tag. Note that an *alert rule* change ships through prometheus_image_tag instead: the rules are baked into the Prometheus image, not this one."
  type        = string
  default     = "latest"
}

variable "grafana_image_tag" {
  description = "Tag of module.registry's grafana ECR repository to deploy (ST-259). Bumping this and re-applying is how a dashboard change (infra/docker/grafana/dashboards/*.json) ships — same rolling-deploy shape as erpnext_image_tag."
  type        = string
  default     = "latest"
}

variable "loki_image_tag" {
  description = "Tag of module.registry's loki ECR repository to deploy (ST-261). Bumping this and re-applying is how a loki-config.yml.tpl change ships — same rolling-deploy shape as erpnext_image_tag. Ignored in dev (module.logging is not instantiated there)."
  type        = string
  default     = "latest"
}

variable "otel_collector_image_tag" {
  description = "Tag of module.registry's otel-collector ECR repository to deploy (ST-260). Bumping this and re-applying is how a tail-sampling policy change (infra/docker/otel-collector/config.yaml) ships — same rolling-deploy shape as erpnext_image_tag."
  type        = string
  default     = "latest"
}

variable "vector_image_tag" {
  description = "Tag of module.registry's vector ECR repository to deploy (ST-261). Bumping this and re-applying is how a vector.yaml pipeline change (parsing, labels, routing) ships. Ignored in dev."
  type        = string
  default     = "latest"
}

variable "tempo_image_tag" {
  description = "Tag of module.registry's tempo ECR repository to deploy (ST-260). Same rolling-deploy shape as erpnext_image_tag."
  type        = string
  default     = "latest"
}

variable "backup_dr_region" {
  description = "DR region module.backup's cross-region automated-backups replication (modules/backup/replication.tf) ships continuous Postgres/MariaDB backups into. See that variable's own description in modules/backup/variables.tf for the honesty gap around this being an unresearched placeholder."
  type        = string
  default     = "eu-west-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.backup_dr_region))
    error_message = "backup_dr_region must look like an AWS region code, e.g. \"eu-west-1\"."
  }
}

variable "backup_verify_image_tag" {
  description = "Tag of module.registry's backup-verify ECR repository to deploy (ST-265). Bumping this and re-applying is how a change to infra/docker/backup-verify.Dockerfile or its scripts ships — same rolling-deploy shape as erpnext_image_tag."
  type        = string
  default     = "latest"
}

variable "tenant_restore_operator_principal_arns" {
  description = "Passed straight through to module.backup's variable of the same name (ST-267) -- see its description there. Empty by default: nobody can assume the tenant-restore-operator role until an environment's tfvars explicitly lists who should be able to."
  type        = list(string)
  default     = []
}

variable "erpnext_site_hostnames" {
  description = <<-EOT
    Hostnames of the real ERPNext sites module.backup's nightly site-backup and monthly
    restore-drill tasks operate on (ST-265). Empty by default — there is no way to discover this
    list at plan time (sites are created imperatively by infra/deploy/scripts/erpnext-new-site.sh
    after apply, never by Terraform), so it must be maintained by hand alongside every
    erpnext-new-site.sh run. See modules/backup/variables.tf's erpnext_site_hostnames.
  EOT
  type        = list(string)
  default     = []
}

variable "web_origin" {
  description = <<-EOT
    Scheme+host of the apps/web frontend for this environment, e.g. "https://app.studafy.com" or
    "http://localhost:5173" in dev. This is the only origin module.storage's CORS configuration
    allows on the app-files bucket. Public information (it's a frontend URL), so unlike the
    bastion variables above it is committed per environment in *.tfvars, not passed via TF_VAR_*.
  EOT
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.web_origin))
    error_message = "web_origin must be a bare scheme+host, e.g. \"https://app.studafy.com\" (no path, no trailing slash)."
  }
}
