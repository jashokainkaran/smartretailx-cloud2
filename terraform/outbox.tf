resource "aws_dynamodb_table" "product_outbox" {
  name         = "${local.prefix}-product-outbox"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "event_id"

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  attribute {
    name = "event_id"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "pending-index"
    hash_key        = "status"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}