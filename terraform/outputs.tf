output "event_bus_name" {
  description = "Event bus name — set as EVENT_BUS_NAME in the publisher"
  value       = aws_cloudwatch_event_bus.main.name
}

output "inventory_queue_url" {
  description = "Queue URL — set as INVENTORY_QUEUE_URL in the worker"
  value       = aws_sqs_queue.inventory.url
}

output "inventory_dlq_url" {
  description = "DLQ URL, for inspecting failed messages"
  value       = aws_sqs_queue.inventory_dlq.url
}

output "products_table_name" {
  value = aws_dynamodb_table.products.name
}

output "inventory_table_name" {
  value = aws_dynamodb_table.inventory.name
}

output "outbox_table_name" {
  value = aws_dynamodb_table.product_outbox.name
}

output "ecr_product_service_url" {
  value = aws_ecr_repository.product_service.repository_url
}

output "ecr_outbox_relay_url" {
  value = aws_ecr_repository.outbox_relay.repository_url
}

output "payments_table_name" {
  value = aws_dynamodb_table.payments.name
}