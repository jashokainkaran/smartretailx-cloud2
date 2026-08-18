# ---------------------------------------------------------------------------
# WebSocket API + real-time push (CP-020), narrowed to two targets after
# checking who is actually listening when each event fires — full reasoning
# in IMPLEMENTATION_RECORD.md's 2026-08-18 WebSocket update:
#   (A) product-page stock levels — a customer looking at a product page is,
#       by definition, present to see a live count change.
#   (C) a live order feed on the admin dashboard — an admin working the
#       dashboard is watching that screen. This reuses the SAME
#       OrderConfirmed/OrderFailed events already flowing to Notification
#       (not a separate "OrderPlaced" published before the outcome is known
#       — an earlier draft of this design did that, then dropped it once it
#       was clear an admin toast needs the resolved status, not just proof
#       an order exists), plus a genuinely new OrderNeedsReconciliation
#       event for COMPENSATION_FAILED, the one terminal state that
#       otherwise publishes nothing at all.
# Order confirmation is not pushed to the CUSTOMER here: it is already
# returned synchronously in the checkout response. Delivery-status changes
# are not pushed to the customer either: they are almost never present when
# one happens minutes or hours later — that gap is closed with an email
# extension to the Notification service instead (notification_service.tf),
# not a WebSocket.
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "websocket_service" {
  name                 = "${local.prefix}-websocket-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "websocket_service" {
  repository = aws_ecr_repository.websocket_service.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only the 5 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# ---------- Connections table ----------
# One row per open connection, not per customer — the same customer signed
# in on two devices gets two rows. role-index lets the admin-feed push query
# only admin-tagged connections without scanning past every customer row.

resource "aws_dynamodb_table" "websocket_connections" {
  name         = "${local.prefix}-websocket-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "connection_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  attribute {
    name = "role"
    type = "S"
  }

  global_secondary_index {
    name            = "role-index"
    hash_key        = "role"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# ---------- The WebSocket API itself ----------

resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${local.prefix}-websocket"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_stage" "websocket" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = "prod"
  auto_deploy = true
}

# ---------- connect/disconnect: one image, two entrypoints (ADR-024's
# pattern, same as inventory-consumer sharing inventory-api's image) ----------

data "aws_ecr_image" "websocket_service" {
  repository_name = aws_ecr_repository.websocket_service.name
  image_tag       = "latest"
}

resource "aws_iam_role" "websocket_connect" {
  name = "${local.prefix}-websocket-connect-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "websocket_connect" {
  name = "${local.prefix}-websocket-connect-policy"
  role = aws_iam_role.websocket_connect.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.logs_statement,
      local.xray_statement,
      {
        # connect writes a row (and reads nothing back); disconnect deletes
        # one. Neither needs to read the table.
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.websocket_connections.arn
      },
    ]
  })
}

# Deliberately NOT in the VPC. $connect has to reach Cognito's public JWKS
# endpoint to verify a token from scratch (no JWT authorizer type exists for
# WebSocket routes, and there is no VPC endpoint for Cognito in this
# account) — the same reasoning that took Notification out of the VPC for
# SES applies here for a different public AWS-adjacent endpoint.
resource "aws_lambda_function" "websocket_connect" {
  function_name = "${local.prefix}-websocket-connect"
  role          = aws_iam_role.websocket_connect.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.websocket_service.repository_url}@${data.aws_ecr_image.websocket_service.image_digest}"

  image_config {
    command = ["app.connect.handler"]
  }

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      CONNECTIONS_TABLE    = aws_dynamodb_table.websocket_connections.name
      COGNITO_USER_POOL_ID = local.cognito_user_pool_id
      COGNITO_CLIENT_ID    = local.cognito_web_client_id
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_lambda_function" "websocket_disconnect" {
  function_name = "${local.prefix}-websocket-disconnect"
  role          = aws_iam_role.websocket_connect.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.websocket_service.repository_url}@${data.aws_ecr_image.websocket_service.image_digest}"

  image_config {
    command = ["app.disconnect.handler"]
  }

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      CONNECTIONS_TABLE = aws_dynamodb_table.websocket_connections.name
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_log_group" "websocket_connect" {
  name              = "/aws/lambda/${aws_lambda_function.websocket_connect.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "websocket_disconnect" {
  name              = "/aws/lambda/${aws_lambda_function.websocket_disconnect.function_name}"
  retention_in_days = 14
}

resource "aws_apigatewayv2_integration" "connect" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.websocket_connect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.connect.id}"
}

resource "aws_lambda_permission" "connect" {
  statement_id  = "AllowWebsocketConnect"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.websocket_connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/$connect"
}

resource "aws_apigatewayv2_integration" "disconnect" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.websocket_disconnect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.disconnect.id}"
}

resource "aws_lambda_permission" "disconnect" {
  statement_id  = "AllowWebsocketDisconnect"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.websocket_disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/$disconnect"
}

# No $default route: clients here only ever receive pushes, never send a
# message after connecting, so an unrecognised inbound message simply isn't
# handled — there is nothing for it to trigger.

# ---------- The push path: EventBridge -> SQS -> one consumer Lambda ----------
# Both event types below are published best-effort by their source service
# (see push_consumer.py's own docstring) — not through a transactional
# outbox, deliberately: a lost stock tick or a missed "new order" toast loses
# nothing that matters, since DynamoDB already has the correct state.

resource "aws_sqs_queue" "websocket_push_dlq" {
  name                      = "${local.prefix}-websocket-push-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "websocket_push" {
  name                       = "${local.prefix}-websocket-push"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.websocket_push_dlq.arn
    maxReceiveCount     = var.dlq_max_receive_count
  })
}

resource "aws_cloudwatch_event_rule" "stock_level_changed" {
  name           = "${local.prefix}-stock-level-changed"
  description    = "Route StockLevelChanged events to the WebSocket push queue"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["smartretailx.inventory"]
    detail-type = ["StockLevelChanged"]
  })
}

# Order confirmed/failed: reuses the SAME two rules notification_service.tf
# already defines and routes to the Notification queue — one more target on
# each, not a duplicate rule. Both now fan out to two queues from one event.
resource "aws_cloudwatch_event_target" "order_confirmed_to_push" {
  rule           = aws_cloudwatch_event_rule.order_confirmed.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.websocket_push.arn
}

resource "aws_cloudwatch_event_target" "order_failed_to_push" {
  rule           = aws_cloudwatch_event_rule.order_failed.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.websocket_push.arn
}

# The one genuinely new event type: fires only on COMPENSATION_FAILED
# (saga.py's two compensation-failure branches), which otherwise publishes
# no event at all — the admin dashboard is the only place this becomes
# visible in real time, short of polling /orders/stuck.
resource "aws_cloudwatch_event_rule" "order_needs_reconciliation" {
  name           = "${local.prefix}-order-needs-reconciliation"
  description    = "Route OrderNeedsReconciliation events to the WebSocket push queue"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["smartretailx.orders"]
    detail-type = ["OrderNeedsReconciliation"]
  })
}

resource "aws_cloudwatch_event_target" "stock_level_changed_to_push" {
  rule           = aws_cloudwatch_event_rule.stock_level_changed.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.websocket_push.arn
}

resource "aws_cloudwatch_event_target" "order_needs_reconciliation_to_push" {
  rule           = aws_cloudwatch_event_rule.order_needs_reconciliation.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.websocket_push.arn
}

# One policy resource, four statements — same reason as notification_service.tf:
# a second aws_sqs_queue_policy on the same queue would overwrite this one,
# and a single ArnEquals condition only takes one value. order_confirmed and
# order_failed are the SAME rule objects notification_service.tf already
# authorizes to send to the notifications queue — this is a separate
# authorization, for a separate queue, not a duplicate.
resource "aws_sqs_queue_policy" "websocket_push" {
  queue_url = aws_sqs_queue.websocket_push.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowStockLevelChanged"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.websocket_push.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.stock_level_changed.arn
          }
        }
      },
      {
        Sid       = "AllowOrderConfirmedToPush"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.websocket_push.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.order_confirmed.arn
          }
        }
      },
      {
        Sid       = "AllowOrderFailedToPush"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.websocket_push.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.order_failed.arn
          }
        }
      },
      {
        Sid       = "AllowOrderNeedsReconciliation"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.websocket_push.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.order_needs_reconciliation.arn
          }
        }
      },
    ]
  })
}

resource "aws_iam_role" "websocket_push_consumer" {
  name = "${local.prefix}-websocket-push-consumer-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "websocket_push_consumer" {
  name = "${local.prefix}-websocket-push-consumer-policy"
  role = aws_iam_role.websocket_push_consumer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.logs_statement,
      local.xray_statement,
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.websocket_push.arn
      },
      {
        # Scan for the stock-broadcast case, Query on role-index for the
        # admin-only case, DeleteItem to clean up a connection once AWS
        # reports it gone (410).
        Effect = "Allow"
        Action = [
          "dynamodb:Scan",
          "dynamodb:Query",
          "dynamodb:DeleteItem",
        ]
        Resource = [
          aws_dynamodb_table.websocket_connections.arn,
          "${aws_dynamodb_table.websocket_connections.arn}/index/*",
        ]
      },
      {
        # Scoped to this one WebSocket API's connections specifically — not
        # "*" — matching the least-privilege shape already used everywhere
        # else in this project (Notification's SES grant scoped to one
        # identity, order-api's DynamoDB grant scoped to one table).
        Effect   = "Allow"
        Action   = "execute-api:ManageConnections"
        Resource = "arn:aws:execute-api:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${aws_apigatewayv2_api.websocket.id}/${aws_apigatewayv2_stage.websocket.name}/POST/@connections/*"
      },
    ]
  })
}

# Deliberately NOT in the VPC — same reasoning as the connect/disconnect
# functions above, but for a different public endpoint: pushing to a
# WebSocket connection means calling API Gateway's Management API, which
# this account has no VPC endpoint for.
resource "aws_lambda_function" "websocket_push_consumer" {
  function_name = "${local.prefix}-websocket-push-consumer"
  role          = aws_iam_role.websocket_push_consumer.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.websocket_service.repository_url}@${data.aws_ecr_image.websocket_service.image_digest}"

  image_config {
    command = ["app.push_consumer.handler"]
  }

  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      CONNECTIONS_TABLE             = aws_dynamodb_table.websocket_connections.name
      WEBSOCKET_MANAGEMENT_ENDPOINT = "https://${aws_apigatewayv2_api.websocket.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.websocket.name}"
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_log_group" "websocket_push_consumer" {
  name              = "/aws/lambda/${aws_lambda_function.websocket_push_consumer.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_event_source_mapping" "websocket_push_queue" {
  event_source_arn = aws_sqs_queue.websocket_push.arn
  function_name    = aws_lambda_function.websocket_push_consumer.arn

  batch_size                         = 10
  maximum_batching_window_in_seconds = 1

  # Without this, one bad record failing the whole invocation means SQS
  # retries the entire batch — including messages already pushed
  # successfully, showing an admin a duplicate toast for one genuinely new
  # event. Same fix Notification's own queue already has.
  function_response_types = ["ReportBatchItemFailures"]
}
