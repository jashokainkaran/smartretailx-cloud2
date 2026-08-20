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

output "orders_table_name" {
  value = aws_dynamodb_table.orders.name
}

output "order_outbox_table_name" {
  value = aws_dynamodb_table.order_outbox.name
}

# The single base URL for the frontend, and the value the Order saga uses to
# reach the other services.
output "api_base_url" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "vpc_id" {
  value = aws_vpc.main.id
}

# The WebSocket connection URL (CP-020) — a separate endpoint from
# api_base_url above; API Gateway does not let an HTTP API and a WebSocket
# API share one gateway.
output "websocket_url" {
  value = "${aws_apigatewayv2_api.websocket.api_endpoint}/${aws_apigatewayv2_stage.websocket.name}"
}

# The single public entry point: serves the React build at / and proxies
# the API at /api/*, so the frontend needs no separate API host and no CORS.
output "site_url" {
  value = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

# CD needs this to invalidate the right distribution after a frontend
# deploy — it was being read by cd.yml with no corresponding output ever
# defined, which would have failed the deploy the first time that step ran.
output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "waf_web_acl_arn" {
  value = aws_wafv2_web_acl.main.arn
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "vpc_endpoints" {
  description = "Gateway endpoints are free; interface endpoints are billed hourly per AZ."
  value = {
    dynamodb_gateway = aws_vpc_endpoint.dynamodb.id
    interface        = { for k, v in aws_vpc_endpoint.interface : k => v.id }
  }
}

output "ecr_inventory_service_url" {
  value = aws_ecr_repository.inventory_service.repository_url
}

output "ecr_payment_service_url" {
  value = aws_ecr_repository.payment_service.repository_url
}

output "ecr_order_service_url" {
  value = aws_ecr_repository.order_service.repository_url
}

# Function names, so the three-step image deploy can be scripted rather than
# retyped (ADR-027: mutable tags mean Terraform cannot see a new push).
output "http_service_function_names" {
  value = { for k, v in aws_lambda_function.http_service : k => v.function_name }
}

# These are public identifiers, safe to place in the React build. They are
# outputs so the frontend setup never needs to copy a value by hand.
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_web_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

# Public identifier only. The test-user passwords are GitHub Environment
# secrets and are never Terraform variables, outputs or repository files.
output "cognito_integration_test_client_id" {
  value = aws_cognito_user_pool_client.integration_test.id
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}
