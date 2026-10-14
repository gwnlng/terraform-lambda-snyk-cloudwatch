variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to all resource names"
  type        = string
  default     = "snyk-audit-logs"
}

variable "tags" {
  description = "Tags applied to all resources through provider default_tags"
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC the Lambda functions run in"
  type        = string
  default     = "10.43.0.0/16"
}

variable "service_azs" {
  description = "Number of availability zones to span"
  type        = number
  default     = 2
}

variable "snyk_group_id" {
  description = "Snyk Group ID whose organizations are listed"
  type        = string
  default     = "ff0c78bb-6365-462c-8576-e73de8793870"
}

variable "snyk_api_host" {
  description = "Snyk REST API host (use https://api.eu.snyk.io, https://api.au.snyk.io, etc. for other regions)"
  type        = string
  default     = "https://api.snyk.io"
}

variable "snyk_api_version" {
  description = "Snyk REST API version query parameter"
  type        = string
  default     = "2026-03-25"
}

# This is the rate at which the state machine will be triggered
# the lambda function calcuates the from (date) API parameter based on the scheduledTime, set to 3600 seconds
variable "schedule_expression" {
  description = "EventBridge Scheduler expression that triggers the state machine"
  type        = string
  default     = "rate(1 hour)"
}

variable "map_max_concurrency" {
  description = "Maximum number of organizations processed in parallel by the state machine"
  type        = number
  default     = 5
}

variable "lambda_runtime" {
  description = "Node.js Lambda runtime"
  type        = string
  default     = "nodejs22.x"
}

variable "worker_timeout" {
  description = "TransferAuditLogs timeout in seconds"
  type        = number
  default     = 900
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for Lambda logs and the audit log group"
  type        = number
  default     = 14
}
