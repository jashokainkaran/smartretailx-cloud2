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