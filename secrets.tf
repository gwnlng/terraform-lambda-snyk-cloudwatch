# -----------------------------------------------------------------------------
# Snyk API token. The secret is created empty; set the value out-of-band so it
# never lands in Terraform state:
#   aws secretsmanager put-secret-value --secret-id <snyk_secret_arn> \
#     --secret-string '{"Snyk_Token":"<token>"}'
# A plain-string secret value is accepted too.
# -----------------------------------------------------------------------------

module "secrets_manager" {
  source  = "terraform-aws-modules/secrets-manager/aws"
  version = "~> 2.0"

  # Secret
  name                    = "snyk_group_api_token"
  description             = "Snyk API token used to list organizations and read audit logs"
  recovery_window_in_days = 0

  # Policy
  create_policy         = true
  create_secret_version = false
  block_public_policy   = true
  policy_statements = {
    read = {
      sid = "AllowAccountRead"
      principals = [{
        type        = "AWS"
        identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
      }]
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["*"]
    }
  }

  tags = var.tags
}