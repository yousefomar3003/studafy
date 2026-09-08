variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "aws_region" {
  description = "Primary AWS region (var.aws_region at the root), for the awslogs log driver configuration and for building this module's own ARNs."
  type        = string
}

variable "automation_enabled" {
  description = <<-EOT
    Whether the recurring, cost-bearing parts of this module are created: cross-region automated
    backup replication, the AWS Backup vault/plan/selection (monthly immutable snapshot), and the
    EventBridge Scheduler schedules that run the restore-verify/backup/drill tasks on a cadence.
    false in dev (root's local.backup_automation_enabled, mirroring local.erpnext_plane_enabled and
    local.monitoring_enabled) — dev has no DR requirement, but it still gets the Postgres
    restore-verify task definition itself (see restore_verify.tf), registered but never scheduled,
    so an operator can run it by hand for the "PITR to arbitrary timestamp demonstrated in dev"
    acceptance criterion via infra/deploy/scripts/postgres-restore-verify.sh.
  EOT
  type        = bool
}

variable "erpnext_plane_enabled" {
  description = "Whether the ERPNext/MariaDB plane exists in this environment (root's local.erpnext_plane_enabled). Gates every MariaDB/ERPNext-specific resource in this module (mariadb.tf, erpnext_backup.tf) — mirrors module.mariadb/module.erpnext's own count in the root module."
  type        = bool
}

# --- Networking -----------------------------------------------------------------------------

variable "vpc_id" {
  description = "VPC ID, e.g. module.network.vpc_id. Only used to validate provider configuration is wired correctly — no VPC-scoped resource is created directly against this value."
  type        = string
}

variable "private_app_subnet_ids" {
  description = "Private app-tier subnet IDs, e.g. module.network.private_app_subnet_ids. Every ECS task this module runs launches here (NAT route for ECR/Secrets Manager/S3/RDS API calls), same tier modules/erpnext and modules/monitoring already use."
  type        = list(string)

  validation {
    condition     = length(var.private_app_subnet_ids) > 0
    error_message = "private_app_subnet_ids must contain at least one subnet."
  }
}

variable "backup_security_group_id" {
  description = "Security group for the Postgres restore-verify task, e.g. module.network.backup_security_group_id. Egresses to the database only — see modules/network/security_groups.tf's \"Backup\" section."
  type        = string
}

variable "erpnext_security_group_id" {
  description = <<-EOT
    Security group for the ERPNext site-backup/restore-drill tasks, e.g.
    module.network.erpnext_security_group_id. Reused rather than a dedicated group: these tasks
    must join the erpnext plane's own EFS NFS self-referencing rule to mount the shared `sites`
    volume, and already need its egress to MariaDB/Redis/HTTPS/DNS — a second group would need every
    one of those rules duplicated for no isolation benefit (bench backup/restore already run with
    the same blast radius as the backend/queue roles that mount the same volume read-write). null
    when erpnext_plane_enabled is false; every resource that needs it is itself count-gated on that
    same flag.
  EOT
  type        = string
  default     = null
}

# --- Compute (shared with the rest of the ECS cluster) --------------------------------------

variable "cluster_arn" {
  description = "ECS cluster ARN to run this module's one-off tasks in, e.g. module.compute.cluster_arn. Shares the cluster with api/realtime/workers/erpnext/monitoring rather than provisioning a second one — same reasoning as modules/erpnext's own cluster_arn variable."
  type        = string
}

variable "execution_role_arn" {
  description = <<-EOT
    Shared ECS task-execution role ARN, e.g. module.compute.execution_role_arn. Only used for ECR
    pull and awslogs (AmazonECSTaskExecutionRolePolicy, already attached by modules/compute) — this
    module's tasks read Secrets Manager/S3/RDS themselves at runtime via their own task role
    (task_role.tf), not through ECS `secrets` injection, so nothing here needs to be added to
    module.secrets' service map or the execution role's own policy attachments.
  EOT
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for this module's task log groups. Same default as modules/erpnext/monitoring."
  type        = number
  default     = 30
}

# --- Postgres plane ---------------------------------------------------------------------------

variable "postgres_db_instance_id" {
  description = "module.postgres.db_instance_id. Used to build the instance ARN (for AWS Backup selection and cross-region replication) and as the source identifier for the weekly restore-to-point-in-time drill."
  type        = string
}

variable "postgres_address" {
  description = "module.postgres.address (write endpoint, host only). Passed to the restore-verify task as the baseline it diffs the restored scratch instance's row counts/checksums against."
  type        = string
}

variable "postgres_port" {
  description = "module.postgres.port / var.db_port."
  type        = number
}

variable "postgres_connection_secret_arn" {
  description = "module.postgres.connection_secret_arn. The restore-verify task reads this itself (secretsmanager:GetSecretValue on its own task role) for the master username/password — the scratch instance restored from it inherits the same credential unchanged, so one secret authenticates against both the source and the restored copy."
  type        = string
}

variable "postgres_db_subnet_group_name" {
  description = "module.network.db_subnet_group_name. The scratch instance the restore-verify task creates is restored into this same subnet group — it never leaves the private-data tier."
  type        = string
}

variable "postgres_db_security_group_id" {
  description = "module.network.db_security_group_id. Attached to the scratch instance so the restore-verify task (in backup_security_group_id, which db's own ingress rules admit) can reach it."
  type        = string
}

variable "postgres_backup_retention_days" {
  description = "module.postgres's own backup_retention_days. Passed straight through as the retention_period for this module's cross-region automated-backups replication (replication.tf) — the replica's retention window matches the source's, never longer, since a replica can't outlive backups the source itself has already expired."
  type        = number
  default     = 7
}

# --- MariaDB / ERPNext plane (erpnext_plane_enabled only) -------------------------------------

variable "mariadb_db_instance_id" {
  description = "module.mariadb[0].db_instance_id. null when erpnext_plane_enabled is false."
  type        = string
  default     = null
}

variable "mariadb_backup_retention_days" {
  description = "module.mariadb's own backup_retention_days, for the same reason as postgres_backup_retention_days above."
  type        = number
  default     = 7
}

variable "erpnext_image_repository_url" {
  description = "module.registry.repository_urls[\"erpnext\"]. The site-backup/restore-drill tasks reuse this exact bench image (infra/docker/erpnext.Dockerfile) rather than a dedicated one — they run bench backup/restore/doctor, the same bench CLI already baked in for the backend/queue roles. null when erpnext_plane_enabled is false."
  type        = string
  default     = null
}

variable "erpnext_image_tag" {
  description = "Tag of erpnext_image_repository_url to run, e.g. var.erpnext_image_tag at the root — kept in lockstep with the long-running bench roles' own image so a drill always exercises the same bench version currently serving traffic."
  type        = string
  default     = "latest"
}

variable "erpnext_efs_file_system_id" {
  description = "module.erpnext[0].efs_file_system_id. null when erpnext_plane_enabled is false."
  type        = string
  default     = null
}

variable "erpnext_efs_access_point_id" {
  description = "module.erpnext[0].efs_access_point_id. null when erpnext_plane_enabled is false."
  type        = string
  default     = null
}

variable "erpnext_mariadb_address" {
  description = "module.mariadb[0].address. Plain environment variable, not a secret — matches modules/erpnext's own mariadb_address convention."
  type        = string
  default     = null
}

variable "erpnext_mariadb_port" {
  description = "var.mariadb_port at the root."
  type        = number
  default     = 3306
}

variable "erpnext_mariadb_connection_secret_arn" {
  description = "module.mariadb[0].connection_secret_arn. Read by the task itself via its own task role, same pattern as postgres_connection_secret_arn."
  type        = string
  default     = null
}

variable "erpnext_redis_primary_endpoint_address" {
  description = "module.redis.primary_endpoint_address. bench backup/restore need a working site_config.json, which points at the same Redis cache/queue DBs the long-running bench roles use."
  type        = string
  default     = null
}

variable "erpnext_redis_port" {
  description = "var.redis_port at the root."
  type        = number
  default     = 6379
}

variable "erpnext_redis_cache_db" {
  description = "module.erpnext's redis_cache_db, must match exactly (docs/runbooks/redis-conventions.md)."
  type        = number
  default     = 2
}

variable "erpnext_redis_queue_db" {
  description = "module.erpnext's redis_queue_db, must match exactly."
  type        = number
  default     = 3
}

variable "erpnext_redis_auth_secret_arn" {
  description = "module.redis.auth_secret_arn."
  type        = string
  default     = null
}

variable "erpnext_site_hostnames" {
  description = <<-EOT
    Hostnames of the real ERPNext sites the nightly backup task iterates (one `bench backup` per
    site) — there is no "list sites" API this module can call at plan time, since sites are created
    imperatively by infra/deploy/scripts/erpnext-new-site.sh after apply, so the list must be
    supplied explicitly. Empty by default: a freshly-applied environment has no sites yet, and an
    empty list makes the nightly task a documented no-op (it logs "no sites configured" and exits 0)
    rather than a hard failure. Update this alongside every erpnext-new-site.sh run.
  EOT
  type        = list(string)
  default     = []
}

# --- Storage -----------------------------------------------------------------------------------

variable "backups_archive_bucket_name" {
  description = "module.storage.backups_archive_bucket_id. Every report artifact and every ERPNext site/database backup this module produces lands under a prefix in this one bucket — see README.md's \"Object layout\"."
  type        = string
}

variable "backups_archive_bucket_arn" {
  description = "module.storage.backups_archive_bucket_arn, for scoping this module's task role IAM policies."
  type        = string
}

# --- Cross-region replication + immutable monthly snapshot (automation_enabled only) ----------

variable "dr_region" {
  description = <<-EOT
    AWS region module.postgres's/module.mariadb's automated backups are continuously replicated
    into (replication.tf), i.e. the region a real regional outage would fail DR over to. No
    researched DR-region decision exists yet in this repo (same honesty gap postgres_instance_class
    and aws_region already carry in the root README) — "eu-west-1" is a placeholder chosen only for
    being a distinct region from eu-central-1 that AWS itself pairs for EU customers; confirm and
    override via TF_VAR_backup_dr_region before this is relied on for a real failover.
  EOT
  type        = string
  default     = "eu-west-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.dr_region))
    error_message = "dr_region must look like an AWS region code, e.g. \"eu-west-1\"."
  }
}

variable "vault_lock_min_retention_days" {
  description = <<-EOT
    Minimum days a recovery point in the locked monthly vault must be kept before it can be deleted
    — enforced by AWS Backup Vault Lock in Compliance mode (main.tf), which no principal, including
    the account root, can shorten or remove once changeable_for_days elapses. 400 days (a little
    over 13 months) so that even the *first* monthly snapshot taken after a lock is still present
    when the *thirteenth* one lands, giving a full rolling year of monthly immutable copies at
    steady state. Not a researched compliance requirement — a documented starting point, same
    honesty-gap convention as noncurrent_version_expiration_days in modules/storage.
  EOT
  type        = number
  default     = 400

  validation {
    condition     = var.vault_lock_min_retention_days >= 1
    error_message = "vault_lock_min_retention_days must be at least 1."
  }
}

variable "vault_lock_changeable_for_days" {
  description = <<-EOT
    Grace period (days) during which the vault lock configuration can still be changed or removed
    before it becomes permanently immutable. AWS Backup's own minimum is 3; kept at that minimum
    rather than raised, so a misconfiguration applied by mistake has the shortest possible window
    before it becomes unfixable, while still satisfying the "immutable" acceptance criterion once
    the window closes.
  EOT
  type        = number
  default     = 3

  validation {
    condition     = var.vault_lock_changeable_for_days >= 3
    error_message = "vault_lock_changeable_for_days must be at least 3 (AWS Backup's own minimum)."
  }
}

variable "backup_plan_monthly_schedule" {
  description = "AWS Backup plan cron expression (AWS Backup's own cron dialect, not EventBridge's) for the monthly immutable snapshot rule. Default: 04:00 UTC on the 1st of every month, clear of every RDS instance's own backup_window (03:00-05:00 UTC, modules/postgres/mariadb defaults) by design — actually overlapping windows only cost extra I/O during the automated backup, never a correctness issue, but keeping them staggered makes CloudWatch metrics easier to read during the monthly rule's run."
  type        = string
  default     = "cron(0 4 1 * ? *)"
}

# --- Restore-verify / backup / drill container images -----------------------------------------

variable "backup_verify_image_repository_url" {
  description = "module.registry.repository_urls[\"backup-verify\"] (infra/docker/backup-verify.Dockerfile)."
  type        = string
}

variable "backup_verify_image_tag" {
  description = "Tag of backup_verify_image_repository_url to run."
  type        = string
  default     = "latest"
}

# --- Schedules (EventBridge Scheduler, AWS's own cron dialect — automation_enabled only) ------

variable "postgres_restore_verify_schedule" {
  description = "When the weekly Postgres restore-verify task runs. Default: 06:00 UTC every Monday, after module.postgres's own 03:00-05:00 backup_window so the restore always has a completed backup to work from."
  type        = string
  default     = "cron(0 6 ? * MON *)"
}

variable "erpnext_site_backup_schedule" {
  description = "When the nightly ERPNext site+database backup task runs. Default: 02:00 UTC daily, inside module.mariadb's own 03:00-05:00 automated-backup window's lead-in so the bench-level and RDS-level backups aren't racing over the same I/O."
  type        = string
  default     = "cron(0 2 * * ? *)"
}

variable "erpnext_restore_drill_schedule" {
  description = "When the monthly ERPNext restore drill runs. Default: 05:00 UTC on the 2nd of every month — after the 1st-of-month AWS Backup rule and the same night's site-backup task have both landed, so the drill always restores a backup taken very recently."
  type        = string
  default     = "cron(0 5 2 * ? *)"
}
