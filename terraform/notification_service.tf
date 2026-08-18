# ---------------------------------------------------------------------------
# Notification service (ADR-006, CP-025): a deliberately thin second
# consumer on the SAME event bus the Inventory consumer already listens to.
# Order already publishes OrderConfirmed/OrderFailed on every checkout —
# this only adds a second, independent subscriber; nothing about the Order
# service changes to support it, which is the actual point of an event bus.
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "notification_service" {
  name                 = "${local.prefix}-notification-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "notification_service" {
  repository = aws_ecr_repository.notification_service.name

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

# ---------- Idempotency table ----------
# SQS is at-least-once. A conditional PutItem keyed on the event's own
# event_id is what stops a duplicate delivery from sending the same receipt
# twice — the same trick create_stock_record() already uses for the
# Inventory consumer (ADR-022).

resource "aws_dynamodb_table" "notifications" {
  name         = "${local.prefix}-notifications"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "event_id"

  attribute {
    name = "event_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---------- Dead-letter queue ----------

resource "aws_sqs_queue" "notifications_dlq" {
  name                      = "${local.prefix}-notifications-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

# ---------- Main queue ----------

resource "aws_sqs_queue" "notifications" {
  name                       = "${local.prefix}-notifications"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notifications_dlq.arn
    maxReceiveCount     = var.dlq_max_receive_count
  })
}

# ---------- Rules: which events go to this queue ----------
# Two separate rules, not one with a list match, because they are two
# distinct business events that happen to share a destination — a future
# third notification-worthy event type is one more rule, not a change to
# these two.

resource "aws_cloudwatch_event_rule" "order_confirmed" {
  name           = "${local.prefix}-order-confirmed"
  description    = "Route OrderConfirmed events to the Notification queue"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["smartretailx.orders"]
    detail-type = ["OrderConfirmed"]
  })
}

resource "aws_cloudwatch_event_rule" "order_failed" {
  name           = "${local.prefix}-order-failed"
  description    = "Route OrderFailed events to the Notification queue"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["smartretailx.orders"]
    detail-type = ["OrderFailed"]
  })
}

resource "aws_cloudwatch_event_target" "order_confirmed_to_notifications" {
  rule           = aws_cloudwatch_event_rule.order_confirmed.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.notifications.arn
}

resource "aws_cloudwatch_event_target" "order_failed_to_notifications" {
  rule           = aws_cloudwatch_event_rule.order_failed.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.notifications.arn
}

# One aws_sqs_queue_policy resource — SQS has exactly one policy document
# per queue, so a second resource targeting the same queue_url would just
# overwrite this one, not add to it. Both rules get their own statement in
# the SAME document instead, each scoped to its own rule's ARN via
# aws:SourceArn — a single condition key takes one value, so a list here
# would only ever authorise whichever rule Terraform happened to put first.
resource "aws_sqs_queue_policy" "notifications" {
  queue_url = aws_sqs_queue.notifications.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowOrderConfirmed"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.notifications.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.order_confirmed.arn
          }
        }
      },
      {
        Sid       = "AllowOrderFailed"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.notifications.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.order_failed.arn
          }
        }
      },
    ]
  })
}

# ---------- SES identity ----------
# Creating this resource starts SES's own verification flow — AWS sends a
# confirmation link to var.notification_sender_email. Terraform shows the
# identity as created regardless; "created" is not "verified", and sends
# will fail with an SES error until the address is actually verified.

resource "aws_ses_email_identity" "sender" {
  email = var.notification_sender_email
}

# ---------- Execution role ----------

resource "aws_iam_role" "notification_service" {
  name = "${local.prefix}-notification-service-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "notification_service" {
  name = "${local.prefix}-notification-service-policy"
  role = aws_iam_role.notification_service.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.notifications.arn
      },
      {
        # PutItem only, conditional on attribute_not_exists in code — the
        # same least-privilege shape as the Inventory consumer's role. This
        # role never needs to read or update a notification record, only
        # ever record that one was sent, once.
        Effect   = "Allow"
        Action   = "dynamodb:PutItem"
        Resource = aws_dynamodb_table.notifications.arn
      },
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
        ]
        # Scoped to the one sender identity this service is allowed to send
        # as — not "*". A compromised function credential could still only
        # send as this one already-public-facing address, not spoof anyone
        # else SES might have verified in this account later.
        Resource = aws_ses_email_identity.sender.arn
      },
      local.xray_statement,
      local.vpc_access_statement,
    ]
  })
}

# ---------- The function ----------

resource "aws_lambda_function" "notification_service" {
  function_name = "${local.prefix}-notification-service"
  role          = aws_iam_role.notification_service.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.notification_service.repository_url}:latest"

  image_config {
    command = ["app.handler.handler"]
  }

  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      NOTIFICATIONS_TABLE = aws_dynamodb_table.notifications.name
      SENDER_EMAIL        = var.notification_sender_email
    }
  }

  # Same placement as the Inventory consumer: private subnets, no internet
  # route. SQS is polled by the Lambda service from outside the VPC, so the
  # trigger itself needs no endpoint — only the outbound DynamoDB and SES
  # calls need a path out, and SES has no VPC endpoint used here, so this
  # function needs the same public-egress consideration order-api already
  # has. See the note on aws_lambda_function.http_service["order"] for the
  # precedent.
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_log_group" "notification_service" {
  name              = "/aws/lambda/${aws_lambda_function.notification_service.function_name}"
  retention_in_days = 14
}

# ---------- SQS trigger ----------

resource "aws_lambda_event_source_mapping" "notifications_queue" {
  event_source_arn = aws_sqs_queue.notifications.arn
  function_name    = aws_lambda_function.notification_service.arn

  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
}
