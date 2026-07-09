locals {
  name_prefix = "${var.project}-${var.environment}"

  canonical_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
