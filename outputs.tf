output "snyk_secret_arn" {
  description = "Secrets Manager secret to populate with the Snyk token"
  value       = module.secrets_manager.secret_arn
}

output "state_machine_arn" {
  description = "ARN of the audit log transfer state machine"
  value       = module.state_machine.state_machine_arn
}

output "status_table_name" {
  description = "DynamoDB table holding per-org transfer results"
  value       = module.audit_transfer_table.dynamodb_table_id
}

output "audit_log_group" {
  description = "CloudWatch log group receiving the transferred audit logs"
  value       = aws_cloudwatch_log_group.audit_logs.name
}
