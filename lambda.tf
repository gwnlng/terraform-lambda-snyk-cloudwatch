# -----------------------------------------------------------------------------
# Lambda functions (TypeScript, transpiled and bundled by esbuild into lambda/dist;
# run `make build` first). `make build` also zips lambda/dist into
# lambda/function.zip, which both functions use; only the handler differs.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "audit_logs" {
  name              = "/snyk/${var.name_prefix}/audit-logs"
  retention_in_days = var.log_retention_days
}

module "get_snyk_orgs" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.9"

  function_name = "GetSnykOrgs"
  description   = "Generator: lists all Snyk organizations in the Group and emits one work item per org"
  runtime       = var.lambda_runtime
  handler       = "get_snyk_orgs.handler"

  create_package         = false
  local_existing_package = "${path.module}/lambda/function.zip"

  timeout     = 120
  memory_size = 256
  publish     = true

  vpc_subnet_ids         = module.vpc.private_subnets
  vpc_security_group_ids = [module.lambda_security_group.id]
  attach_network_policy  = true

  logging_log_format                = "JSON"
  cloudwatch_logs_retention_in_days = var.log_retention_days

  environment_variables = {
    SNYK_SECRET_ARN  = module.secrets_manager.secret_arn
    SNYK_GROUP_ID    = var.snyk_group_id
    SNYK_API_HOST    = var.snyk_api_host
    SNYK_API_VERSION = var.snyk_api_version
  }

  attach_policy_statements = true
  policy_statements = {
    read_secret = {
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [module.secrets_manager.secret_arn]
    }
  }

  tags = var.tags
}

module "transfer_audit_logs" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.9"

  function_name = "TransferAuditLogs"
  description   = "Worker: copies one org's audit logs for a time window into CloudWatch Logs and records the result in DynamoDB"
  runtime       = var.lambda_runtime
  handler       = "transfer_audit_logs.handler"

  create_package         = false
  local_existing_package = "${path.module}/lambda/function.zip"

  timeout     = var.worker_timeout
  memory_size = 512
  publish     = true

  vpc_subnet_ids         = module.vpc.private_subnets
  vpc_security_group_ids = [module.lambda_security_group.id]
  attach_network_policy  = true

  logging_log_format                = "JSON"
  cloudwatch_logs_retention_in_days = var.log_retention_days

  environment_variables = {
    SNYK_SECRET_ARN  = module.secrets_manager.secret_arn
    SNYK_API_HOST    = var.snyk_api_host
    SNYK_API_VERSION = var.snyk_api_version
    AUDIT_LOG_GROUP  = aws_cloudwatch_log_group.audit_logs.name
    STATUS_TABLE     = module.audit_transfer_table.dynamodb_table_id
  }

  attach_policy_statements = true
  policy_statements = {
    read_secret = {
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [module.secrets_manager.secret_arn]
    }
    write_audit_logs = {
      effect    = "Allow"
      actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DeleteLogStream"]
      resources = ["${aws_cloudwatch_log_group.audit_logs.arn}:*"]
    }
    list_audit_log_streams = {
      effect    = "Allow"
      actions   = ["logs:DescribeLogStreams"]
      resources = [aws_cloudwatch_log_group.audit_logs.arn]
    }
    write_status = {
      effect    = "Allow"
      actions   = ["dynamodb:PutItem"]
      resources = [module.audit_transfer_table.dynamodb_table_arn]
    }
  }

  tags = var.tags
}
