# -----------------------------------------------------------------------------
# Result state of each TransferAuditLogs execution.
# Columns: OrgID, from, to, status ("Completed" | "Failure")
# -----------------------------------------------------------------------------
module "audit_transfer_table" {
  source  = "terraform-aws-modules/dynamodb-table/aws"
  version = "~> 5.0"

  name         = "${var.name_prefix}-transfer-status"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "OrgID"
  range_key    = "from"

  attributes = [
    { name = "OrgID", type = "S" },
    { name = "from", type = "S" },
  ]

  point_in_time_recovery_enabled = true
  server_side_encryption_enabled = true

  tags = var.tags
}
