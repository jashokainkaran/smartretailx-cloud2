# CloudWatch operational alerts are separate from the billing topic because
# CloudWatch alarms and SNS topics must share a region. All runtime alarms are
# in the primary application region, eu-west-1.

resource "aws_sns_topic" "operations_alerts" {
  name = "${local.prefix}-operations-alerts"
}

resource "aws_sns_topic_subscription" "operations_email" {
  topic_arn = aws_sns_topic.operations_alerts.arn
  protocol  = "email"
  endpoint  = local.billing_alert_email
}

locals {
  observed_lambda_functions = merge(
    { for service_name, function in aws_lambda_function.http_service : service_name => function.function_name },
    {
      product_outbox_relay      = aws_lambda_function.outbox_relay.function_name
      order_outbox_relay        = aws_lambda_function.order_outbox_relay.function_name
      inventory_consumer        = aws_lambda_function.inventory_consumer.function_name
      notification_service      = aws_lambda_function.notification_service.function_name
      websocket_push            = aws_lambda_function.websocket_push_consumer.function_name
      websocket_connect         = aws_lambda_function.websocket_connect.function_name
      websocket_disconnect      = aws_lambda_function.websocket_disconnect.function_name
      cognito_post_confirmation = aws_lambda_function.cognito_post_confirmation.function_name
    },
  )

  observed_dlqs = {
    inventory      = aws_sqs_queue.inventory_dlq.name
    notification   = aws_sqs_queue.notifications_dlq.name
    websocket_push = aws_sqs_queue.websocket_push_dlq.name
  }

  # These source queues are shown separately from their DLQs so a slow
  # consumer is visible before messages are dead-lettered.
  observed_queues = {
    inventory      = aws_sqs_queue.inventory.name
    notification   = aws_sqs_queue.notifications.name
    websocket_push = aws_sqs_queue.websocket_push.name
  }

  # Saved Logs Insights queries search these application log groups. API
  # Gateway access logs are intentionally excluded because correlation IDs are
  # emitted by the application services, not by the gateway access log format.
  observed_log_groups = concat(
    [for log_group in values(aws_cloudwatch_log_group.http_service) : log_group.name],
    [
      aws_cloudwatch_log_group.outbox_relay.name,
      aws_cloudwatch_log_group.order_outbox_relay.name,
      aws_cloudwatch_log_group.inventory_consumer.name,
      aws_cloudwatch_log_group.notification_service.name,
      aws_cloudwatch_log_group.websocket_push_consumer.name,
    ],
  )

  observed_tables = {
    products              = aws_dynamodb_table.products.name
    inventory             = aws_dynamodb_table.inventory.name
    orders                = aws_dynamodb_table.orders.name
    payments              = aws_dynamodb_table.payments.name
    order_outbox          = aws_dynamodb_table.order_outbox.name
    product_outbox        = aws_dynamodb_table.product_outbox.name
    notifications         = aws_dynamodb_table.notifications.name
    websocket_connections = aws_dynamodb_table.websocket_connections.name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.observed_lambda_functions

  alarm_name          = "${local.prefix}-${each.key}-lambda-errors"
  alarm_description   = "${each.value} recorded one or more Lambda errors in five minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations_alerts.arn]

  dimensions = {
    FunctionName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  for_each = local.observed_dlqs

  alarm_name          = "${local.prefix}-${each.key}-dlq-messages"
  alarm_description   = "${each.value} contains one or more messages that need investigation."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations_alerts.arn]

  dimensions = {
    QueueName = each.value
  }
}

# The saga already logs this terminal state. Turning the log event into a
# metric makes the serious manual-reconciliation outcome visible and alertable.
resource "aws_cloudwatch_log_metric_filter" "compensation_failed" {
  name           = "${local.prefix}-compensation-failed"
  log_group_name = aws_cloudwatch_log_group.http_service["order"].name
  pattern        = "\"compensation failed\""

  metric_transformation {
    name          = "CompensationFailed"
    namespace     = "SmartRetailX/OrderSaga"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "compensation_failed" {
  alarm_name          = "${local.prefix}-compensation-failed"
  alarm_description   = "An order reached COMPENSATION_FAILED and needs manual reconciliation."
  namespace           = "SmartRetailX/OrderSaga"
  metric_name         = "CompensationFailed"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations_alerts.arn]
}

# The circuit breaker (app/circuit_breaker.py) only ever logged a warning
# when it trips — findable via the trace_correlation_id-style Logs Insights
# queries, but nothing paged anyone. One combined alarm covering both
# breakers (inventory, payment), matching compensation_failed's own
# not-split-by-dimension simplicity — which breaker tripped is one log
# line away once the alarm has already said "look now."
resource "aws_cloudwatch_log_metric_filter" "circuit_opened" {
  name           = "${local.prefix}-circuit-opened"
  log_group_name = aws_cloudwatch_log_group.http_service["order"].name
  pattern        = "\"circuit opened\""

  metric_transformation {
    name          = "CircuitOpened"
    namespace     = "SmartRetailX/OrderSaga"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "circuit_opened" {
  alarm_name          = "${local.prefix}-circuit-opened"
  alarm_description   = "The saga's circuit breaker tripped for Inventory or Payment — a real downstream health problem, not just a single failed request."
  namespace           = "SmartRetailX/OrderSaga"
  metric_name         = "CircuitOpened"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations_alerts.arn]
}

# A Lambda can complete successfully while API Gateway returns a 5xx to the
# browser (for example, because of an integration/configuration failure).
resource "aws_cloudwatch_metric_alarm" "api_gateway_5xx" {
  alarm_name          = "${local.prefix}-api-gateway-5xx"
  alarm_description   = "The public HTTP API returned one or more server errors in five minutes."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations_alerts.arn]

  dimensions = {
    ApiId = aws_apigatewayv2_api.main.id
    Stage = "$default"
  }
}

resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = "${local.prefix}-operations"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Lambda invocations and errors"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 300
          stat    = "Sum"
          metrics = [for function_name in values(local.observed_lambda_functions) : ["AWS/Lambda", "Invocations", "FunctionName", function_name, { label = function_name }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Lambda errors"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 300
          stat    = "Sum"
          metrics = [for function_name in values(local.observed_lambda_functions) : ["AWS/Lambda", "Errors", "FunctionName", function_name, { label = function_name }]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Dead-letter queue messages"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 60
          stat    = "Maximum"
          metrics = [for queue_name in values(local.observed_dlqs) : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", queue_name, { label = queue_name }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "DynamoDB throttle events"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = concat([for table_name in values(local.observed_tables) : [
            ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", table_name, { label = "${table_name} reads" }],
            ["AWS/DynamoDB", "WriteThrottleEvents", "TableName", table_name, { label = "${table_name} writes" }],
          ]]...)
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway HTTP errors"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["AWS/ApiGateway", "4xx", "ApiId", aws_apigatewayv2_api.main.id, "Stage", "$default", { label = "4xx" }],
            ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.main.id, "Stage", "$default", { label = "5xx" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Order saga manual reconciliation and circuit breaker trips"
          view   = "timeSeries"
          region = var.aws_region
          period = 60
          stat   = "Sum"
          metrics = [
            ["SmartRetailX/OrderSaga", "CompensationFailed", { label = "COMPENSATION_FAILED" }],
            ["SmartRetailX/OrderSaga", "CircuitOpened", { label = "Circuit breaker opened" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway p95 latency"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          stat   = "p95"
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.main.id, "Stage", "$default", { label = "End-to-end latency" }],
            ["AWS/ApiGateway", "IntegrationLatency", "ApiId", aws_apigatewayv2_api.main.id, "Stage", "$default", { label = "Integration latency" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title   = "Lambda p95 duration"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 300
          stat    = "p95"
          metrics = [for function_name in values(local.observed_lambda_functions) : ["AWS/Lambda", "Duration", "FunctionName", function_name, { label = function_name }]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "Lambda throttles"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 300
          stat    = "Sum"
          metrics = [for function_name in values(local.observed_lambda_functions) : ["AWS/Lambda", "Throttles", "FunctionName", function_name, { label = function_name }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "SQS oldest-message age"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 60
          stat    = "Maximum"
          metrics = [for queue_name in values(local.observed_queues) : ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", queue_name, { label = queue_name }]]
        }
      },
    ]
  })
}

# Replace the placeholder with the value returned in an API response or found
# in a service log. This gives one chronological view of a request as it moves
# through synchronous and asynchronous services.
resource "aws_cloudwatch_query_definition" "trace_correlation_id" {
  name            = "${local.prefix}-trace-correlation-id"
  log_group_names = local.observed_log_groups

  query_string = <<-QUERY
    fields @timestamp, @log, @message
    | filter @message like /correlation_id=/
    | parse @message /correlation_id=(?<correlation_id>[^ ]+)/
    | filter correlation_id = "PASTE_CORRELATION_ID_HERE"
    | sort @timestamp asc
  QUERY
}

# This query is deliberately focused on the Order Saga's terminal and unknown
# outcomes, which are the cases an administrator must investigate.
resource "aws_cloudwatch_query_definition" "order_saga_failures" {
  name            = "${local.prefix}-order-saga-failures"
  log_group_names = [aws_cloudwatch_log_group.http_service["order"].name]

  query_string = <<-QUERY
    fields @timestamp, @message
    | filter @message like /order failed|compensation failed|payment outcome unknown|stock outcome unknown/
    | sort @timestamp desc
  QUERY
}

resource "aws_cloudwatch_query_definition" "asynchronous_consumer_errors" {
  name = "${local.prefix}-asynchronous-consumer-errors"
  log_group_names = [
    aws_cloudwatch_log_group.outbox_relay.name,
    aws_cloudwatch_log_group.order_outbox_relay.name,
    aws_cloudwatch_log_group.inventory_consumer.name,
    aws_cloudwatch_log_group.notification_service.name,
    aws_cloudwatch_log_group.websocket_push_consumer.name,
  ]

  query_string = <<-QUERY
    fields @timestamp, @log, @message
    | filter @message like /ERROR|Failed to|Failed to process/
    | sort @timestamp desc
  QUERY
}
