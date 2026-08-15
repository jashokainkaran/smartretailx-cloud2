# ---------- Execution role ----------

resource "aws_iam_role" "outbox_relay" {
  name = "${local.prefix}-outbox-relay-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# ---------- Permissions ----------

resource "aws_iam_role_policy" "outbox_relay" {
  name = "${local.prefix}-outbox-relay-policy"
  role = aws_iam_role.outbox_relay.id

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
        Resource = aws_dynamodb_table.product_outbox.stream_arn
      },
      {
        Effect   = "Allow"
        Action   = "dynamodb:UpdateItem"
        Resource = aws_dynamodb_table.product_outbox.arn
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

resource "aws_lambda_function" "outbox_relay" {
  function_name = "${local.prefix}-outbox-relay"
  role          = aws_iam_role.outbox_relay.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.outbox_relay.repository_url}:latest"

  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      EVENT_BUS_NAME = aws_cloudwatch_event_bus.main.name
      OUTBOX_TABLE   = aws_dynamodb_table.product_outbox.name
    }
  }

  # Private subnets, no internet route. This relay reaches EventBridge
  # through the events interface endpoint; DynamoDB through the free
  # gateway endpoint. Nothing else is reachable from here.
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  # Without this the X-Ray trace of a checkout stops at the synchronous
  # boundary: order-api to inventory-api to payment-api would be visible,
  # and the event publish that follows would not. Tracing the asynchronous
  # half is the point, since that is where the architecture actually is.
  tracing_config {
    mode = "Active"
  }
}

# ---------- Log group ----------

resource "aws_cloudwatch_log_group" "outbox_relay" {
  name              = "/aws/lambda/${aws_lambda_function.outbox_relay.function_name}"
  retention_in_days = 14
}

# ---------- Stream trigger ----------

resource "aws_lambda_event_source_mapping" "outbox_stream" {
  event_source_arn  = aws_dynamodb_table.product_outbox.stream_arn
  function_name     = aws_lambda_function.outbox_relay.arn
  starting_position = "LATEST"

  batch_size                         = 10
  maximum_batching_window_in_seconds = 1

  maximum_retry_attempts = 3
}