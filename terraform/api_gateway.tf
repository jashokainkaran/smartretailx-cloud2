# ---------------------------------------------------------------------------
# One HTTP API in front of all four services, with path-based routing.
#
# Why one gateway rather than one per service: the frontend gets a single
# base URL and a single origin, which removes four CORS configurations and
# four environment variables from the client. The services stay independently
# deployable — each is its own Lambda behind its own route — so the property
# that defines a microservice is preserved; only the front door is shared.
#
# HTTP API (apigatewayv2) rather than REST API (apigateway v1): roughly a
# third of the price, lower latency, and native proxy integration to Lambda.
# What REST API offers that this does not — request validation against a
# model, per-method usage plans and API keys, WAF integration — is either
# already handled inside FastAPI (Pydantic validates every request body far
# more thoroughly than an API Gateway model would) or out of scope here.
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"

  # CORS is deliberately NOT configured at the gateway. Every service already
  # runs FastAPI's CORSMiddleware, and the ANY routes below pass preflight
  # OPTIONS requests through to the Lambda, which answers them. Configuring
  # it in both places produces duplicated Access-Control-Allow-Origin
  # headers, which browsers reject outright — a failure that looks like a
  # CORS bug and is actually a double-configuration bug.
}

resource "aws_apigatewayv2_integration" "http_service" {
  # Iterating the static prefix map rather than local.http_services: only the
  # keys are needed here, and those are known at plan time regardless of what
  # the service values resolve to.
  for_each = local.service_route_prefixes

  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.http_service[each.key].invoke_arn

  # 2.0 delivers the event shape Mangum expects for an HTTP API. The default
  # would be 1.0, the REST API shape, which Mangum can also parse — but
  # mixing the two is a silent source of missing path or query data.
  payload_format_version = "2.0"

  # Slightly above the Lambda's own 30s, so the function's timeout is what
  # fires rather than the gateway's. If the gateway gave up first the saga
  # would be killed mid-flight with no record of how far it got, which is
  # precisely what ADR-033's write-intent-first design exists to avoid.
  timeout_milliseconds = 30000
}

locals {
  # Each service owns one path prefix. Two routes apiece: the collection
  # itself, and everything beneath it. {proxy+} does not match the bare
  # prefix, so "POST /api/v1/orders" needs its own route — omitting it is
  # the classic cause of a 404 on exactly the endpoint you most want.
  service_route_prefixes = {
    product   = "products"
    inventory = "inventory"
    payment   = "payments"
    order     = "orders"
  }
}

resource "aws_apigatewayv2_route" "collection" {
  for_each = local.service_route_prefixes

  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /api/v1/${each.value}"
  target    = "integrations/${aws_apigatewayv2_integration.http_service[each.key].id}"
}

resource "aws_apigatewayv2_route" "sub_paths" {
  for_each = local.service_route_prefixes

  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /api/v1/${each.value}/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.http_service[each.key].id}"
}

# Cognito validates the JWT signature, issuer, intended client and expiry at
# the gateway before the Lambda is invoked. Roles are deliberately checked by
# the service from the trusted claims that API Gateway forwards: a Cognito
# group is an application role, not an OAuth scope.
resource "aws_apigatewayv2_authorizer" "cognito_jwt" {
  api_id          = aws_apigatewayv2_api.main.id
  authorizer_type = "JWT"
  name            = "${local.prefix}-cognito-jwt"

  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.web.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# These exact routes take precedence over the existing broad ANY routes.
# Keeping the broad routes in place avoids a destructive route migration while
# the protected surface is introduced one operation at a time.
locals {
  jwt_routes = {
    product_create           = { service = "product", route_key = "POST /api/v1/products" }
    product_admin_list       = { service = "product", route_key = "GET /api/v1/products/admin" }
    product_image_upload_url = { service = "product", route_key = "POST /api/v1/products/admin/image-upload-url" }
    product_update           = { service = "product", route_key = "PUT /api/v1/products/{product_id}" }
    product_activate         = { service = "product", route_key = "PATCH /api/v1/products/{product_id}/activate" }
    product_deactivate       = { service = "product", route_key = "PATCH /api/v1/products/{product_id}/deactivate" }

    inventory_add          = { service = "inventory", route_key = "POST /api/v1/inventory/{product_id}/add" }
    inventory_reserve_item = { service = "inventory", route_key = "POST /api/v1/inventory/{product_id}/reserve" }
    inventory_release_item = { service = "inventory", route_key = "POST /api/v1/inventory/{product_id}/release" }
    inventory_confirm_item = { service = "inventory", route_key = "POST /api/v1/inventory/{product_id}/confirm" }
    inventory_low_stock    = { service = "inventory", route_key = "GET /api/v1/inventory/admin/low-stock" }

    order_create          = { service = "order", route_key = "POST /api/v1/orders" }
    order_list            = { service = "order", route_key = "GET /api/v1/orders" }
    order_get             = { service = "order", route_key = "GET /api/v1/orders/{order_id}" }
    order_stuck           = { service = "order", route_key = "GET /api/v1/orders/stuck" }
    order_admin_list      = { service = "order", route_key = "GET /api/v1/orders/admin" }
    order_admin_summary   = { service = "order", route_key = "GET /api/v1/orders/admin/summary" }
    order_delivery_status = { service = "order", route_key = "PATCH /api/v1/orders/{order_id}/delivery-status" }

    payment_get    = { service = "payment", route_key = "GET /api/v1/payments/{payment_id}" }
    payment_refund = { service = "payment", route_key = "POST /api/v1/payments/{payment_id}/refund" }
  }

  # The order saga is an AWS workload, not a browser user. These requests are
  # signed with the Order Lambda role and cannot be made with a Cognito token.
  iam_routes = {
    product_batch     = { service = "product", route_key = "POST /api/v1/products/batch" }
    inventory_reserve = { service = "inventory", route_key = "POST /api/v1/inventory/reserve" }
    inventory_release = { service = "inventory", route_key = "POST /api/v1/inventory/release" }
    inventory_confirm = { service = "inventory", route_key = "POST /api/v1/inventory/confirm" }
    payment_charge    = { service = "payment", route_key = "POST /api/v1/payments" }
  }
}

resource "aws_apigatewayv2_route" "jwt" {
  for_each = local.jwt_routes

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.value.route_key
  target             = "integrations/${aws_apigatewayv2_integration.http_service[each.value.service].id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id

  # New service code checks the forwarded claims. Update all Lambda images
  # before exposing the corresponding protected gateway routes.
  depends_on = [aws_lambda_function.http_service]
}

resource "aws_apigatewayv2_route" "iam" {
  for_each = local.iam_routes

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.value.route_key
  target             = "integrations/${aws_apigatewayv2_integration.http_service[each.value.service].id}"
  authorization_type = "AWS_IAM"

  depends_on = [aws_lambda_function.http_service]
}

# API Gateway must be granted permission to invoke each function. Scoped to
# this API's execution ARN, so no other gateway in the account can call them.
resource "aws_lambda_permission" "api_gateway" {
  for_each = local.service_route_prefixes

  statement_id  = "AllowInvokeFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_service[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ---------- Stage ----------

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${local.prefix}-api"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.main.id

  # "$default" gives a clean URL with no stage segment, so the base URL the
  # frontend holds is exactly the api_endpoint. A named stage would append
  # /dev to every path, which then has to be stripped or configured
  # everywhere.
  name        = "$default"
  auto_deploy = true

  # Access logging is the request-level record CloudWatch metrics cannot
  # give you: which route, which status, how long, and the requestId that
  # ties a gateway entry to the Lambda log line it produced.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId       = "$context.requestId"
      ip              = "$context.identity.sourceIp"
      requestTime     = "$context.requestTime"
      httpMethod      = "$context.httpMethod"
      routeKey        = "$context.routeKey"
      status          = "$context.status"
      protocol        = "$context.protocol"
      responseLength  = "$context.responseLength"
      integrationTime = "$context.integrationLatency"
      totalTime       = "$context.responseLatency"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = true

    # A throttle is a cost control as much as a protection: nothing here
    # should ever see this volume, so if it does, something is wrong and
    # the bill should not be the way you find out.
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}
