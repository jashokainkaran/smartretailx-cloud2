# ---------------------------------------------------------------------------
# Order outbox — the same transactional-outbox pattern as the product
# catalogue (ADR-020), applied to OrderConfirmed / OrderFailed.
#
# The Order service writes an order's terminal state and its outgoing event
# in one TransactWriteItems. A second relay Lambda, built from the SAME
# container image as the product relay with a different OUTBOX_TABLE, drains
# this table's stream onto the shared event bus. That is the ADR-024
# one-image-many-deployments pattern: no new code, only new configuration.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "order_outbox" {
  name         = "${local.prefix}-order-outbox"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "event_id"

  attribute {
    name = "event_id"
    type = "S"
  }

  # GSI keys — declared because they are keys, nothing else.
  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  # NEW_IMAGE: the relay needs the record's other fields (event_type,
  # payload, event_source), not just the changed attributes.
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  # Sparse recovery index. The relay REMOVEs `status` on publication, so a
  # published record loses a value for this index's hash key and drops out
  # entirely. What remains is exactly the set of events still owed.
  #
  # It exists despite the relay being stream-driven because DynamoDB Streams
  # retain records for only 24 hours: if the relay were broken for longer
  # than that, the stream events would age out and nothing would ever
  # re-trigger those records. This index is the query path a recovery
  # process needs to find them.
  global_secondary_index {
    name            = "pending-index"
    hash_key        = "status"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  # Published records expire 7 days after publication, bounding table growth
  # without a cleanup job.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---------- Execution role ----------
#
# A separate role from the product relay, rather than widening that one.
# Least privilege: this function can read only the order outbox stream and
# update only the order outbox table. Neither relay can touch the other's
# data, even though they run identical code.

resource "aws_iam_role" "order_outbox_relay" {
  name = "${local.prefix}-order-outbox-relay-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "order_outbox_relay" {
  name = "${local.prefix}-order-outbox-relay-policy"
  role = aws_iam_role.order_outbox_relay.id

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
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams",
        ]
        Resource = aws_dynamodb_table.order_outbox.stream_arn
      },
      {
        # UpdateItem only. The relay marks records published; it never
        # creates or deletes one.
        Effect   = "Allow"
        Action   = "dynamodb:UpdateItem"
        Resource = aws_dynamodb_table.order_outbox.arn
      },
      {
        Effect   = "Allow"
        Action   = "events:PutEvents"
        Resource = aws_cloudwatch_event_bus.main.arn
      },
      local.xray_statement,
      local.vpc_access_statement,
    ]
  })
}

# ---------- The function ----------

resource "aws_lambda_function" "order_outbox_relay" {
  function_name = "${local.prefix}-order-outbox-relay"
  role          = aws_iam_role.order_outbox_relay.arn
  package_type  = "Image"

  # The SAME image as the product relay. Only OUTBOX_TABLE differs.
  image_uri = "${aws_ecr_repository.outbox_relay.repository_url}:latest"

  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      EVENT_BUS_NAME = aws_cloudwatch_event_bus.main.name
      OUTBOX_TABLE   = aws_dynamodb_table.order_outbox.name
    }
  }

  # Private subnets, no internet route. The relays reach EventBridge through
  # the events interface endpoint; the consumer reaches only DynamoDB, via
  # the free gateway endpoint. Its SQS trigger needs no endpoint at all —
  # the Lambda service polls the queue from outside the VPC.
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_log_group" "order_outbox_relay" {
  name              = "/aws/lambda/${aws_lambda_function.order_outbox_relay.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_event_source_mapping" "order_outbox_stream" {
  event_source_arn  = aws_dynamodb_table.order_outbox.stream_arn
  function_name     = aws_lambda_function.order_outbox_relay.arn
  starting_position = "LATEST"

  batch_size                         = 10
  maximum_batching_window_in_seconds = 1

  maximum_retry_attempts = 3
}

# NOTE: no EventBridge rule routes OrderConfirmed / OrderFailed anywhere
# yet, because no consumer exists. The events reach the bus and match
# nothing, which is the correct behaviour for a published event with no
# subscribers — and is precisely the decoupling the bus is for. The
# Notification service adds the rule and its queue when it is built.
