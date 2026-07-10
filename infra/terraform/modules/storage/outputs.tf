output "app_files_bucket_id" {
  description = "Name of the app-files bucket, e.g. \"studafy-prod-app-files\"."
  value       = aws_s3_bucket.this["app_files"].id
}

output "app_files_bucket_arn" {
  description = "ARN of the app-files bucket. Grant s3:PutObject/GetObject (scoped to the caller's schoolId prefix — see the key-scheme doc) to the IAM role that generates pre-signed URLs."
  value       = aws_s3_bucket.this["app_files"].arn
}

output "app_files_bucket_regional_domain_name" {
  description = "Regional virtual-hosted-style domain of app-files, e.g. \"studafy-prod-app-files.s3.eu-central-1.amazonaws.com\". Use this (not the global s3.amazonaws.com form) when constructing pre-signed URLs so requests don't take an extra redirect hop."
  value       = aws_s3_bucket.this["app_files"].bucket_regional_domain_name
}

output "backups_archive_bucket_id" {
  description = "Name of the backups-archive bucket, e.g. \"studafy-prod-backups-archive\"."
  value       = aws_s3_bucket.this["backups_archive"].id
}

output "backups_archive_bucket_arn" {
  description = "ARN of the backups-archive bucket. Grant s3:PutObject to the backup job's IAM role, not to anything that generates browser-facing pre-signed URLs — this bucket has no CORS configuration."
  value       = aws_s3_bucket.this["backups_archive"].arn
}
