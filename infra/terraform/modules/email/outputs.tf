output "configuration_set_name" {
  description = "SES_CONFIGURATION_SET for apps/workers; null where email is not enabled."
  value       = var.enabled ? aws_sesv2_configuration_set.transactional[0].configuration_set_name : null
}

output "events_topic_arn" {
  description = "EMAIL_EVENTS_SNS_TOPIC_ARN for apps/api's webhook; null where email is not enabled."
  value       = var.enabled ? aws_sns_topic.email_events[0].arn : null
}
