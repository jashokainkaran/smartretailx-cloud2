resource "aws_ecr_repository" "inventory_service" {
  name                 = "${local.prefix}-inventory-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "inventory_service" {
  repository = aws_ecr_repository.inventory_service.name

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

# ---------- Execution role ----------

resource "aws_iam_role" "inventory_consumer" {
  name = "${local.prefix}-inventory-consumer-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "inventory_consumer" {
  name = "${local.prefix}-inventory-consumer-policy"
  role = aws_iam_role.inventory_consumer.id

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
        Resource = aws_sqs_queue.inventory.arn
      },
      {
        Effect   = "Allow"
        Action   = "dynamodb:PutItem"
        Resource = aws_dynamodb_table.inventory.arn
      },
    ]
  })
}

# ---------- The function ----------

resource "aws_lambda_function" "inventory_consumer" {
  function_name = "${local.prefix}-inventory-consumer"
  role          = aws_iam_role.inventory_consumer.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.inventory_service.repository_url}:latest"

  image_config {
    command = ["app.consumer.handler"]
  }

  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      INVENTORY_TABLE = aws_dynamodb_table.inventory.name
    }
  }
}

resource "aws_cloudwatch_log_group" "inventory_consumer" {
  name              = "/aws/lambda/${aws_lambda_function.inventory_consumer.function_name}"
  retention_in_days = 14
}

# ---------- SQS trigger ----------

resource "aws_lambda_event_source_mapping" "inventory_queue" {
  event_source_arn = aws_sqs_queue.inventory.arn
  function_name    = aws_lambda_function.inventory_consumer.arn

  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
}