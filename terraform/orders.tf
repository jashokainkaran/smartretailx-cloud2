resource "aws_dynamodb_table" "orders" {
  name         = "${local.prefix}-orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "order_id"

  attribute {
    name = "order_id"
    type = "S"
  }

  # Declared only because they are GSI keys. DynamoDB is schemaless for
  # every other attribute — you declare an attribute here if and only if
  # it is part of a key somewhere.
  attribute {
    name = "customer_id"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  attribute {
    name = "saga_status"
    type = "S"
  }

  # "My orders", newest first. Without this, listing a customer's orders
  # would mean a full table Scan with a filter — cost proportional to every
  # order in the system rather than to the ones being returned.
  global_secondary_index {
    name            = "customer-orders-index"
    hash_key        = "customer_id"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  # The sparse recovery index — the same technique as the outbox's
  # pending-index (ADR-020).
  #
  # A DynamoDB GSI only indexes items that have a value for EVERY one of
  # its key attributes. saga_status is written while the saga is in flight
  # and REMOVEd when an order reaches CONFIRMED or REJECTED, so those
  # orders drop out of this index entirely. It is deliberately RETAINED for
  # PAYMENT_UNKNOWN and COMPENSATION_FAILED (ADR-034, ADR-035), which are
  # terminal but require human reconciliation.
  #
  # The index therefore holds exactly two categories: orders still running,
  # and orders somebody must fix. In a healthy system it is near-empty, and
  # anything that lingers in it is by construction a problem — which is
  # what makes it queryable by an admin endpoint and alarmable in
  # CloudWatch.
  global_secondary_index {
    name            = "saga-status-index"
    hash_key        = "saga_status"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  # Continuous backups, restorable to any point in the last 35 days.
  # Orders are financial records: an order lost to accidental deletion or
  # a bad write is a customer who paid and has no evidence of it.
  point_in_time_recovery {
    enabled = true
  }
}
