# -----------------------------------------------------------------------------
# State machine: GetSnykOrgs -> Map(TransferAuditLogs per org).
# Execution data is excluded from the Step Functions log so org/user details
# are not duplicated there; the Snyk token is never part of any state input.
# -----------------------------------------------------------------------------
module "state_machine" {
  source  = "terraform-aws-modules/step-functions/aws"
  version = "~> 5.0"

  name = "${var.name_prefix}-state-machine"
  type = "STANDARD"

  definition = templatefile("${path.module}/asl/state_machine.json.tftpl", {
    get_snyk_orgs_arn       = module.get_snyk_orgs.lambda_function_qualified_arn
    transfer_audit_logs_arn = module.transfer_audit_logs.lambda_function_qualified_arn
    map_max_concurrency     = var.map_max_concurrency
  })

  service_integrations = {
    lambda = {
      lambda = [
        module.get_snyk_orgs.lambda_function_qualified_arn,
        module.transfer_audit_logs.lambda_function_qualified_arn,
      ]
    }
  }

  logging_configuration = {
    include_execution_data = false
    level                  = "ERROR"
  }
  cloudwatch_log_group_retention_in_days = var.log_retention_days

  tags = var.tags
}
