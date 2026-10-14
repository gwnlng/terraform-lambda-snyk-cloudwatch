# -----------------------------------------------------------------------------
# Network: VPC with private subnets for the Lambda functions and NAT egress
# to reach the Snyk REST API.
# -----------------------------------------------------------------------------
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.7"

  name = "${var.name_prefix}-vpc"
  cidr = var.vpc_cidr

  azs             = chunklist(data.aws_availability_zones.available.names, var.service_azs)[0]
  private_subnets = [for x in range(var.service_azs) : cidrsubnet(cidrsubnet(var.vpc_cidr, 1, 0), 3, x)]
  public_subnets  = [for x in range(var.service_azs) : cidrsubnet(cidrsubnet(var.vpc_cidr, 1, 1), 3, x)]

  enable_nat_gateway   = true
  single_nat_gateway   = false # one NAT gateway per AZ
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = var.tags
}

module "lambda_security_group" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 6.0"

  name        = "${var.name_prefix}-lambda-sg"
  description = "Lambda functions: HTTPS egress only (Snyk API and AWS APIs via NAT)"
  vpc_id      = module.vpc.vpc_id

  egress_rules = {
    https-443-tcp = {
      description = "HTTPS to Snyk API, Secrets Manager, CloudWatch Logs and DynamoDB via the NAT gateway"
      cidr_ipv4   = "0.0.0.0/0"
      ip_protocol = "tcp"
      from_port   = 443
      to_port     = 443
    }
  }

  tags = var.tags
}
