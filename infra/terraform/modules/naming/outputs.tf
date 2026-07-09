output "name_prefix" {
  description = "Canonical resource name prefix, e.g. \"studafy-prod\"."
  value       = local.name_prefix
}

output "tags" {
  description = "Canonical tags merged with extra_tags."
  value       = merge(local.canonical_tags, var.extra_tags)
}
