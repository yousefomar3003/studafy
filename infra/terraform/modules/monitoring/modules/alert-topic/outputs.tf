output "topic_arn" {
  description = "ARN of the SNS topic. Goes into every alarm's alarm_actions/ok_actions in this region."
  value       = aws_sns_topic.this.arn
}
