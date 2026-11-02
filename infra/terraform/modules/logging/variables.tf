variable "name_prefix" {
  description = "Canonical resource prefix, for example studafy-prod (module.naming.name_prefix)."
  type        = string
}

variable "aws_region" {
  description = "Region the pipeline runs in. Used for the Loki S3 client, the Vector aws_s3 source, and the Firehose delivery stream."
  type        = string
}

variable "environment" {
  description = "Terraform environment (dev | staging | prod). Used only as the fallback value of the `env` label Vector stamps on lines that arrive without their own `env` field."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID the Cloud Map private DNS namespace (logging.internal) is created in."
  type        = string
}

variable "cluster_arn" {
  description = "ECS cluster ARN (module.compute) the Vector and Loki Fargate services run in."
  type        = string
}

variable "execution_role_arn" {
  description = <<-EOT
    Shared ECS task execution role ARN (module.compute). Reused exactly as module.monitoring
    reuses it — it only pulls the image and wires the awslogs driver at task launch. The Vector
    and Loki task *roles* (the identities the running containers use to reach S3/SQS) are created
    by this module, not this one.
  EOT
  type        = string
}

variable "private_app_subnet_ids" {
  description = "Private app-tier subnet IDs the Vector and Loki tasks run in. They reach S3/SQS/ECR/Firehose over the NAT path, the same as every other Fargate task in this repo."
  type        = list(string)
}

variable "logging_security_group_id" {
  description = "Security group ID for the logging plane (module.network's aws_security_group.logging): east-west on the Loki port only, plus HTTPS/DNS egress. Nothing connects in from outside the plane except the bastion and Grafana."
  type        = string
}

variable "loki_port" {
  description = "TCP port Loki serves its HTTP API (queries, pushes) on. Shared with module.network's own loki_port so the security-group rule and the Vector sink / Grafana datasource URL can never drift apart — same convention as grafana_port (ST-259)."
  type        = number
  default     = 3100
}

variable "app_log_group_names" {
  description = <<-EOT
    CloudWatch Logs group names shipped through the main pipeline (api/realtime/workers/migrations
    — module.compute.log_group_names). Each is subscribed to the main Firehose, lands in the
    archive bucket, and is read by Vector into Loki. An individual line still routes a write-once
    copy if it carries `kind = "security"`, regardless of which group it came from.
  EOT
  type        = list(string)
}

variable "security_log_group_names" {
  description = <<-EOT
    CloudWatch Logs group names every line of which is a security event (today: the bastion's SSH
    audit log — module.network.bastion_ssh_log_group_name). These are subscribed to *both*
    Firehoses: the main one (so the lines are searchable in Loki like everything else) and the
    dedicated security one, which writes them straight to the Object-Lock bucket with no collector
    in the path. That is the "mirrored write-once" guarantee. Empty is valid — the security
    Firehose is still created, just idle.
  EOT
  type        = list(string)
  default     = []
}

variable "vector_image" {
  description = "Full image reference (registry/repo:tag) for this repo's Vector image (infra/docker/vector.Dockerfile — infra/docker/vector/vector.yaml layered onto the upstream timberio/vector image), pushed to module.registry's \"vector\" repository."
  type        = string
}

variable "loki_image" {
  description = "Full image reference (registry/repo:tag) for this repo's Loki image (infra/docker/loki.Dockerfile — infra/docker/loki/loki-config.yml layered onto the upstream grafana/loki image), pushed to module.registry's \"loki\" repository."
  type        = string
}

# --- Retention ---------------------------------------------------------------------------------
#
# The pipeline keeps logs in two deliberately decoupled stores. "hot" is Loki's own object store,
# trimmed by its compactor; "cold" is the archive bucket Firehose writes every delivered line to,
# trimmed by an S3 lifecycle rule. Loki deleting a chunk at 30d has no effect on the archive copy,
# and vice versa — that separation is the point (SAD §28: "30d hot / 13mo cold").

variable "loki_retention" {
  description = "Loki's compactor retention_period — its Go duration syntax (e.g. \"720h\" = 30d). This is the HOT, queryable window. Lines older than this are deleted from the loki-chunks bucket; their copy in the archive bucket is untouched."
  type        = string
  default     = "720h"

  validation {
    condition     = can(regex("^[0-9]+h$", var.loki_retention))
    error_message = "loki_retention must be a whole number of hours with an 'h' suffix, e.g. \"720h\"."
  }
}

variable "archive_transition_days" {
  description = "Age at which an archived log object transitions from S3 Standard to Glacier Instant Retrieval — the boundary between hot and cold. Matches loki_retention (30d): once a line falls out of Loki's queryable window there is no reason to keep its archive copy on a hot storage class."
  type        = number
  default     = 30

  validation {
    condition     = var.archive_transition_days >= 1
    error_message = "archive_transition_days must be at least 1 (S3 lifecycle has no sub-day granularity)."
  }
}

variable "archive_expiration_days" {
  description = "Age at which an archived log object is deleted. 395 = 13 months (13 * 30 + 5 days' slack), the COLD retention SAD §28 calls for. Must be greater than archive_transition_days."
  type        = number
  default     = 395

  validation {
    condition     = var.archive_expiration_days > var.archive_transition_days
    error_message = "archive_expiration_days must be greater than archive_transition_days."
  }
}

variable "security_lock_retention_days" {
  description = <<-EOT
    S3 Object Lock default retention, in days, applied to every object in the security bucket in
    COMPLIANCE mode: not the root account, not this module, nothing can delete or overwrite a
    security log object before this elapses. 395 = 13 months, matching the cold-archive window —
    the security stream's write-once mirror is kept exactly as long as the ordinary cold copy,
    just tamper-proof.
  EOT
  type        = number
  default     = 395

  validation {
    condition     = var.security_lock_retention_days >= 1
    error_message = "security_lock_retention_days must be at least 1."
  }
}

# --- Firehose / SQS sizing -------------------------------------------------------------------

variable "firehose_buffer_seconds" {
  description = "Firehose buffering hint (seconds) before it flushes a batch to the archive bucket. The floor of the stdout-to-queryable latency — see this module's README. 60-900."
  type        = number
  default     = 60

  validation {
    condition     = var.firehose_buffer_seconds >= 60 && var.firehose_buffer_seconds <= 900
    error_message = "firehose_buffer_seconds must be between 60 and 900 (Firehose's allowed range for an extended_s3 destination)."
  }
}

variable "firehose_buffer_mib" {
  description = "Firehose buffering hint (MiB) before it flushes a batch. Whichever of this and firehose_buffer_seconds is reached first triggers the flush. 1-128."
  type        = number
  default     = 5

  validation {
    condition     = var.firehose_buffer_mib >= 1 && var.firehose_buffer_mib <= 128
    error_message = "firehose_buffer_mib must be between 1 and 128."
  }
}

variable "sqs_max_receive_count" {
  description = "How many times Vector may fail to process an S3-notification message before SQS moves it to the dead-letter queue. Guards against one poison object (a truncated Firehose put, say) wedging the pipeline."
  type        = number
  default     = 5

  validation {
    condition     = var.sqs_max_receive_count >= 1
    error_message = "sqs_max_receive_count must be at least 1."
  }
}

# --- Fargate sizing -------------------------------------------------------------------------

variable "vector_desired_count" {
  description = "Number of Vector tasks. >1 is safe: the aws_s3 source is SQS-driven, so tasks share the work of one queue with no coordination and no duplicate delivery (SQS at-least-once plus Loki's own dedupe on identical (labels, timestamp, line))."
  type        = number
  default     = 2

  validation {
    condition     = var.vector_desired_count >= 1
    error_message = "vector_desired_count must be at least 1."
  }
}

variable "vector_cpu" {
  description = "Fargate CPU units for each Vector task."
  type        = number
  default     = 512
}

variable "vector_memory" {
  description = "Fargate memory (MiB) for each Vector task."
  type        = number
  default     = 1024
}

variable "loki_cpu" {
  description = "Fargate CPU units for the Loki task."
  type        = number
  default     = 512
}

variable "loki_memory" {
  description = "Fargate memory (MiB) for the Loki task."
  type        = number
  default     = 1024
}

variable "loki_storage_gb" {
  description = "Fargate ephemeral storage (GiB) for the Loki task. Only working directories (index download, compactor scratch) live here — chunks and the index are in S3 — so this is small. 21-200; 20 is Fargate's included minimum, so 21 is the first paid increment."
  type        = number
  default     = 30

  validation {
    condition     = var.loki_storage_gb >= 21 && var.loki_storage_gb <= 200
    error_message = "loki_storage_gb must be between 21 and 200."
  }
}

variable "plane_log_retention_days" {
  description = "CloudWatch Logs retention for the pipeline's *own* container/Firehose log groups (Vector, Loki, Firehose delivery errors) — operational noise about the pipeline itself, not the aggregated application logs it carries."
  type        = number
  default     = 30
}
