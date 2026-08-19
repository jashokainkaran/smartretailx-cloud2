# Cost governance is intentionally alerting-only: AWS Budgets cannot stop
# existing resources. The low threshold lets the project owner stop an
# unexpected spend before running further deployed tests.

locals {
  billing_alert_email = coalesce(var.billing_alert_email, var.notification_sender_email)
}

# AWS Budgets allows at most five notifications per budget. Separate actual
# and forecast budgets let SmartRetailX keep the required 50/80/100 alerts for
# both views without silently dropping one.
resource "aws_budgets_budget" "monthly_actual_cost" {
  provider = aws.us_east_1

  name              = "${local.prefix}-monthly-actual-cost"
  budget_type       = "COST"
  limit_amount      = tostring(var.monthly_budget_limit_usd)
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2026-08-01_00:00"

  dynamic "notification" {
    for_each = toset([50, 80, 100])

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [local.billing_alert_email]
    }
  }
}

resource "aws_budgets_budget" "monthly_forecast_cost" {
  provider = aws.us_east_1

  name              = "${local.prefix}-monthly-forecast-cost"
  budget_type       = "COST"
  limit_amount      = tostring(var.monthly_budget_limit_usd)
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2026-08-01_00:00"

  dynamic "notification" {
    for_each = toset([50, 80, 100])

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "FORECASTED"
      subscriber_email_addresses = [local.billing_alert_email]
    }
  }
}

# The AWS/Billing metric exists only in us-east-1. AWS console billing-alert
# preferences must also be enabled manually before this alarm can receive data.
resource "aws_sns_topic" "billing_alerts" {
  provider = aws.us_east_1

  name = "${local.prefix}-billing-alerts"
}

resource "aws_sns_topic_subscription" "billing_email" {
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.billing_alerts.arn
  protocol  = "email"
  endpoint  = local.billing_alert_email
}

resource "aws_cloudwatch_metric_alarm" "estimated_charges" {
  provider = aws.us_east_1

  alarm_name          = "${local.prefix}-estimated-charges"
  alarm_description   = "Estimated AWS charges reached the SmartRetailX monthly alert threshold."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  statistic           = "Maximum"
  period              = 21600
  evaluation_periods  = 1
  threshold           = var.monthly_budget_limit_usd
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.billing_alerts.arn]

  dimensions = {
    Currency = "USD"
  }
}
