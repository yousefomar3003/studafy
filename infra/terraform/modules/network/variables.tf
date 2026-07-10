variable "name_prefix" {
  description = "Canonical resource name prefix from module.naming, e.g. \"studafy-prod\"."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for the VPC. Must be /20 or larger: subnets are carved out as /(prefix+4) blocks (3 tiers x 3 AZs = up to 9), and each tier needs headroom to grow within its /4 block of the address space."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid IPv4 CIDR with a prefix length of /20 or larger (e.g. /16)."
  }
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across. AWS requires DB/ElastiCache subnet groups to span at least 2 AZs, and eu-central-1 has exactly 3."
  type        = number
  default     = 2

  validation {
    condition     = contains([2, 3], var.az_count)
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "If true, all private-app subnets share one NAT gateway (cheaper, single point of failure). If false, one NAT gateway per AZ (higher cost, no cross-AZ blast radius). Private-data subnets never route through NAT regardless of this setting."
  type        = bool
  default     = true
}

variable "app_ports" {
  description = "TCP ports the load balancer forwards to the app tier, e.g. apps/api (3000) and apps/realtime (3001, includes its /ws upgrade route)."
  type        = list(number)
  default     = [3000, 3001]

  validation {
    condition     = length(var.app_ports) > 0 && alltrue([for p in var.app_ports : p > 0 && p <= 65535])
    error_message = "app_ports must be a non-empty list of valid TCP ports (1-65535)."
  }
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the load balancer on 80/443. Default is the public internet, since the ALB is the intended public entry point."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.alb_ingress_cidrs) > 0 && alltrue([for c in var.alb_ingress_cidrs : can(cidrhost(c, 0))])
    error_message = "alb_ingress_cidrs must be a non-empty list of valid IPv4 CIDRs."
  }
}

variable "app_egress_cidr_blocks" {
  description = "CIDRs the app tier may reach on 443 for outbound API calls. Security groups filter by IP, not domain name, so narrow this to known provider IP ranges once third-party integrations are chosen; the default permits any HTTPS destination."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.app_egress_cidr_blocks) > 0 && alltrue([for c in var.app_egress_cidr_blocks : can(cidrhost(c, 0))])
    error_message = "app_egress_cidr_blocks must be a non-empty list of valid IPv4 CIDRs."
  }
}

variable "db_port" {
  description = "TCP port the database listens on. No database engine is chosen yet, so this is a placeholder (Postgres default) for the app-tier/bastion security group rules; override once one is picked."
  type        = number
  default     = 5432

  validation {
    condition     = var.db_port > 0 && var.db_port <= 65535
    error_message = "db_port must be a valid TCP port (1-65535)."
  }
}

variable "redis_port" {
  description = "TCP port Redis listens on. Matches the ioredis default used by apps/workers and apps/realtime (REDIS_URL=redis://localhost:6379)."
  type        = number
  default     = 6379

  validation {
    condition     = var.redis_port > 0 && var.redis_port <= 65535
    error_message = "redis_port must be a valid TCP port (1-65535)."
  }
}

variable "pgbouncer_port" {
  description = "TCP port PgBouncer listens on. Matches the pgbouncer project's own conventional default (distinct from Postgres's 5432, so a client that mistakenly points at the wrong port fails to connect instead of silently reaching the wrong tier)."
  type        = number
  default     = 6432

  validation {
    condition     = var.pgbouncer_port > 0 && var.pgbouncer_port <= 65535
    error_message = "pgbouncer_port must be a valid TCP port (1-65535)."
  }
}

variable "bastion_allowed_ssh_cidrs" {
  description = "CIDRs allowed to SSH into the bastion (e.g. office/VPN egress IPs). Required and deliberately has no default: an operator must make an explicit choice rather than inherit an open one. 0.0.0.0/0 is rejected outright."
  type        = list(string)

  validation {
    condition     = length(var.bastion_allowed_ssh_cidrs) > 0 && alltrue([for c in var.bastion_allowed_ssh_cidrs : can(cidrhost(c, 0))])
    error_message = "bastion_allowed_ssh_cidrs must be a non-empty list of valid IPv4 CIDRs."
  }

  validation {
    condition     = !contains(var.bastion_allowed_ssh_cidrs, "0.0.0.0/0")
    error_message = "bastion_allowed_ssh_cidrs must not include 0.0.0.0/0 — that defeats the point of a bastion."
  }
}

variable "bastion_key_name" {
  description = "Name of an existing EC2 key pair for bastion SSH access. Terraform does not create the key pair (private keys should never pass through state); create it out of band first, e.g. `aws ec2 create-key-pair` or `aws ec2 import-key-pair`."
  type        = string

  validation {
    condition     = length(var.bastion_key_name) > 0
    error_message = "bastion_key_name must reference an existing EC2 key pair."
  }
}

variable "bastion_instance_type" {
  description = "EC2 instance type for the bastion host."
  type        = string
  default     = "t3.micro"
}

variable "enable_flow_logs" {
  description = "Whether to ship VPC flow logs to CloudWatch Logs. Provides the network-level audit trail behind the \"unreachable from public internet\" acceptance criterion."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "CloudWatch Logs retention for VPC flow logs."
  type        = number
  default     = 90
}

variable "ssh_log_retention_days" {
  description = "CloudWatch Logs retention for the bastion's shipped SSH audit log (/var/log/secure)."
  type        = number
  default     = 90
}
