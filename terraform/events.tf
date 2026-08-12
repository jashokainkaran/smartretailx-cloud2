# ---------- Event bus ----------

resource "aws_cloudwatch_event_bus" "main" {
  name = "${local.prefix}-events"
}

# ---------- Dead-letter queue ----------
# Created first: the main queue references it.

resource "aws_sqs_queue" "inventory_dlq" {
  name                      = "${local.prefix}-inventory-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

# ---------- Main queue ----------

resource "aws_sqs_queue" "inventory" {
  name                       = "${local.prefix}-inventory"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.inventory_dlq.arn
    maxReceiveCount     = var.dlq_max_receive_count
  })
}

# ---------- Rule: which events go to this queue ----------

resource "aws_cloudwatch_event_rule" "product_created" {
  name           = "${local.prefix}-product-created"
  description    = "Route ProductCreated events to the Inventory queue"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["smartretailx.catalogue"]
    detail-type = ["ProductCreated"]
  })
}

resource "aws_cloudwatch_event_target" "product_created_to_inventory" {
  rule           = aws_cloudwatch_event_rule.product_created.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = aws_sqs_queue.inventory.arn
}

# ---------- Permission: allow EventBridge to write to the queue ----------

resource "aws_sqs_queue_policy" "inventory" {
  queue_url = aws_sqs_queue.inventory.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.inventory.arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = aws_cloudwatch_event_rule.product_created.arn
        }
      }
    }]
  })
}