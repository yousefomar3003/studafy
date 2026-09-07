output "loki_internal_url" {
  description = "In-VPC base URL of Loki's HTTP API (queries + pushes). Static across environments — see discovery.tf. Consumed by Vector's loki sink and Grafana's Loki datasource; also the target for an SSH-port-forwarded `logcli`/curl from the bastion (docs/runbooks/log-aggregation.md)."
  value       = "http://loki.logging.internal:${var.loki_port}"
}

output "loki_discovery_service_arn" {
  description = "Cloud Map aws_service_discovery_service ARN for Loki."
  value       = aws_service_discovery_service.loki.arn
}

output "archive_bucket_id" {
  description = "Name of the cold-archive bucket (every delivered line, gzipped, ~13-month lifecycle). Pass to `aws s3api get-bucket-lifecycle-configuration` when verifying the retention policy."
  value       = aws_s3_bucket.this["archive"].id
}

output "archive_bucket_arn" {
  description = "ARN of the cold-archive bucket, for scoping any additional reader policy (an Athena workgroup, say)."
  value       = aws_s3_bucket.this["archive"].arn
}

output "security_bucket_id" {
  description = "Name of the write-once security-stream bucket (S3 Object Lock, COMPLIANCE mode). Pass to `aws s3api get-object-lock-configuration` when verifying the write-once guarantee."
  value       = aws_s3_bucket.this["security"].id
}

output "security_bucket_arn" {
  description = "ARN of the write-once security-stream bucket."
  value       = aws_s3_bucket.this["security"].arn
}

output "chunks_bucket_id" {
  description = "Name of Loki's chunk/index store bucket (the hot tier's backing store; lifetime governed by Loki's compactor, not S3)."
  value       = aws_s3_bucket.this["chunks"].id
}

output "ingest_queue_url" {
  description = "URL of the SQS queue Vector drains (S3 ObjectCreated notifications from the archive bucket). Pass to `aws sqs get-queue-attributes` when checking pipeline backlog (ApproximateNumberOfMessages)."
  value       = aws_sqs_queue.ingest.url
}

output "ingest_dlq_url" {
  description = "URL of the dead-letter queue. A non-zero depth here means Vector is repeatedly failing to process some archive object — inspect it before it ages out (14-day retention)."
  value       = aws_sqs_queue.ingest_dlq.url
}

output "firehose_delivery_stream_name" {
  description = "Name of the main Amazon Data Firehose delivery stream (CloudWatch groups -> archive bucket). Pass to `aws firehose describe-delivery-stream` when checking delivery health."
  value       = aws_kinesis_firehose_delivery_stream.logs.name
}

output "firehose_security_delivery_stream_name" {
  description = "Name of the security Amazon Data Firehose delivery stream (security groups -> write-once bucket)."
  value       = aws_kinesis_firehose_delivery_stream.security.name
}

output "vector_service_name" {
  description = "ECS service name for the Vector collector tier."
  value       = aws_ecs_service.vector.name
}

output "loki_service_name" {
  description = "ECS service name for Loki."
  value       = aws_ecs_service.loki.name
}

output "subscribed_log_group_names" {
  description = "Every CloudWatch Logs group forwarded into the main pipeline (app + security). Echoed for `terraform output` verification against the acceptance criterion's cross-service list."
  value       = tolist(local.main_subscription_log_groups)
}

output "security_subscribed_log_group_names" {
  description = "CloudWatch Logs groups additionally mirrored to the write-once security stream."
  value       = tolist(local.security_log_groups)
}

output "pii_audit_hint" {
  description = "How to run the PII audit against a running pipeline (needs an SSH port-forward to Loki from the bastion first — see docs/runbooks/log-aggregation.md)."
  value       = "./modules/logging/scripts/pii-audit.sh --loki-url http://localhost:${var.loki_port} --since 1h"
}
