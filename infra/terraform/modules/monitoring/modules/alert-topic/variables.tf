variable "name" {
  description = "Canonical name for the topic, its KMS alias and its Lambda permission statement id. Must be unique per region within the account, e.g. studafy-prod-alerts or studafy-prod-alerts-us-east-1."
  type        = string
}

variable "bridge_function_arn" {
  description = "ARN of the CloudWatch alert bridge Lambda this topic delivers to. Deliberately allowed to be in another region: SNS supports cross-region Lambda delivery, which is what lets the us-east-1 instantiation reuse the single bridge function rather than duplicating it."
  type        = string
}

variable "bridge_function_name" {
  description = "Name of that same function. Separate from bridge_function_arn because aws_lambda_permission addresses the function by name while aws_sns_topic_subscription addresses it by ARN."
  type        = string
}
