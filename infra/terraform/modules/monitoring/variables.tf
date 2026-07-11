variable "name_prefix" {
  description = "Canonical resource prefix, for example studafy-prod."
  type        = string
}

variable "aws_region" {
  description = "Region displayed by the dashboard widgets."
  type        = string
}

variable "postgres_instance_id" {
  description = "PostgreSQL RDS DBInstanceIdentifier."
  type        = string
}

variable "mariadb_instance_id" {
  description = "MariaDB DBInstanceIdentifier, or null where the ERPNext plane is disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "redis_replication_group_id" {
  description = "ElastiCache replication group identifier."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster containing the application services."
  type        = string
}
