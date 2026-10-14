# -----------------------------------------------------------------------------
# EventBridge Scheduler: starts the state machine on the schedule. The
# scheduled time is passed as input so each run derives a stable window.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "scheduler_start_execution" {
  statement {
    sid       = "StartStateMachine"
    actions   = ["states:StartExecution"]
    resources = [module.state_machine.state_machine_arn]
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "start-state-machine"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_start_execution.json
}

resource "aws_scheduler_schedule" "hourly" {
  name                = "${var.name_prefix}-hourly"
  description         = "Triggers the Snyk audit log transfer state machine"
  schedule_expression = var.schedule_expression

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.state_machine.state_machine_arn
    role_arn = aws_iam_role.scheduler.arn
    # Raw string, not jsonencode(): jsonencode escapes < and > to </>,
    # which stops EventBridge Scheduler from substituting the placeholder.
    input = "{\"scheduledTime\":\"<aws.scheduler.scheduled-time>\"}"
  }
}
