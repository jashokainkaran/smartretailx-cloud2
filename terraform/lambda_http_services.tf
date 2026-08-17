# ---------------------------------------------------------------------------
# The four HTTP APIs as Lambda container functions.
#
# Until now only the auxiliary Lambdas (outbox relay, inventory SQS consumer)
# were deployed; the HTTP APIs ran locally under uvicorn against the AWS data
# plane. This file deploys the APIs themselves. api_gateway.tf puts them
# behind a single gateway.
#
# Each function uses the SAME image its service already builds — the
# Dockerfiles end with CMD ["app.main.handler"], so no image or code change
# is needed to run the identical FastAPI app as a Lambda (ADR-005).
#
# NOTE on environment variables: AWS_REGION is a RESERVED Lambda variable and
# cannot be set here — Lambda injects it, and every service's config.py reads
# it with a sensible default. DYNAMODB_ENDPOINT is deliberately NOT set, so
# boto3 resolves real DynamoDB and the execution role's temporary credentials
# (ADR-025).
# ---------------------------------------------------------------------------

# ---------- ECR repositories still missing ----------

resource "aws_ecr_repository" "payment_service" {
  name                 = "${local.prefix}-payment-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "order_service" {
  name                 = "${local.prefix}-order-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "payment_service" {
  repository = aws_ecr_repository.payment_service.name

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

resource "aws_ecr_lifecycle_policy" "order_service" {
  repository = aws_ecr_repository.order_service.name

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

# ---------- Execution roles ----------
#
# One role per service, written out explicitly rather than shared or
# generated, because the whole point is that they differ. A shared role would
# give the Payment service permission to write inventory, which is exactly
# the blast radius least privilege exists to limit.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  logs_statement = {
    Effect = "Allow"
    Action = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    Resource = "arn:aws:logs:*:*:*"
  }

  # Required by any function with tracing_config mode = "Active".
  #
  # Setting tracing_config WITHOUT this is a silent failure, not an error:
  # the function attempts to publish trace segments, is denied, and records
  # nothing. Tracing appears to be enabled and produces no traces. The
  # resource is "*" because trace segments are not addressable objects —
  # there is no ARN to scope to, which is why AWS ships this as the managed
  # policy AWSXRayDaemonWriteAccess with the same wildcard.
  xray_statement = {
    Effect = "Allow"
    Action = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    Resource = "*"
  }
}

# --- Product API ---
resource "aws_iam_role" "product_api" {
  name               = "${local.prefix}-product-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "product_api" {
  name = "${local.prefix}-product-api-policy"
  role = aws_iam_role.product_api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.logs_statement,
      local.xray_statement,
      local.vpc_access_statement,
      {
        # Scan is required by the paginated listing; BatchGetItem by the
        # batch price lookup the Order saga calls. No DeleteItem: products
        # are soft-deleted via an active flag (ADR-037), so the API has no
        # code path that deletes and the role grants no permission to.
        #
        # TransactWriteItems is listed explicitly even though DynamoDB
        # authorizes create_product()'s transaction via the constituent
        # PutItem grants below, not this action name — confirmed against the
        # live role with `aws iam simulate-principal-policy` and a real
        # invocation. It's added anyway, scoped to exactly the two tables
        # the transaction touches, purely so the policy is self-documenting
        # about what this role does without requiring that constituent-action
        # nuance to be known. Confirmed additive: adding an allowed action
        # cannot change the authorization outcome of any action already
        # allowed.
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Scan",
          "dynamodb:TransactWriteItems",
        ]
        Resource = aws_dynamodb_table.products.arn
      },
      {
        # create_product writes the product and its outbox record in one
        # TransactWriteItems, which needs PutItem on BOTH tables (ADR-020).
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
        ]
        Resource = aws_dynamodb_table.product_outbox.arn
      },
    ]
  })
}

# --- Inventory API ---
#
# A SEPARATE role from the inventory SQS consumer, which grants PutItem only.
# Deploying this API under that role would fail on every read and every
# reserve — a gap recorded in PROJECT_BRIEF and closed here.
resource "aws_iam_role" "inventory_api" {
  name               = "${local.prefix}-inventory-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "inventory_api" {
  name = "${local.prefix}-inventory-api-policy"
  role = aws_iam_role.inventory_api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.logs_statement,
      local.xray_statement,
      local.vpc_access_statement,
      {
        # UpdateItem covers both the single-item conditional writes and the
        # all-or-nothing batch transaction, which is a set of Updates.
        # TransactWriteItems listed for the same self-documenting reason as
        # product-api above — not required (DynamoDB authorizes via the
        # UpdateItem grant), added anyway as explicit, harmless intent.
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:TransactWriteItems",
        ]
        Resource = aws_dynamodb_table.inventory.arn
      },
    ]
  })
}

# --- Payment API ---
resource "aws_iam_role" "payment_api" {
  name               = "${local.prefix}-payment-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "payment_api" {
  name = "${local.prefix}-payment-api-policy"
  role = aws_iam_role.payment_api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.logs_statement,
      local.xray_statement,
      local.vpc_access_statement,
      {
        # No Scan and no DeleteItem. Payments are financial records: nothing
        # in the service enumerates or removes them, so nothing is granted.
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = aws_dynamodb_table.payments.arn
      },
    ]
  })
}

# --- Order API ---
#
# The broadest of the four, because the saga both owns order state and
# coordinates other services. It needs Query on two GSIs, and PutItem on the
# order outbox for the terminal-state transaction. It needs NO permission on
# the products, inventory or payments tables: the saga reaches those services
# over HTTP through the gateway, never through their storage. That boundary
# is database-per-service, enforced by IAM rather than by convention.
resource "aws_iam_role" "order_api" {
  name               = "${local.prefix}-order-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "order_api" {
  name = "${local.prefix}-order-api-policy"
  role = aws_iam_role.order_api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.logs_statement,
      local.xray_statement,
      {
        # Only the Order saga may invoke the internal operations below. Each
        # call is SigV4-signed with this role's temporary Lambda credentials.
        Effect = "Allow"
        Action = "execute-api:Invoke"
        Resource = [
          "${aws_apigatewayv2_api.main.execution_arn}/*/POST/api/v1/products/batch",
          "${aws_apigatewayv2_api.main.execution_arn}/*/POST/api/v1/inventory/reserve",
          "${aws_apigatewayv2_api.main.execution_arn}/*/POST/api/v1/inventory/release",
          "${aws_apigatewayv2_api.main.execution_arn}/*/POST/api/v1/inventory/confirm",
          "${aws_apigatewayv2_api.main.execution_arn}/*/POST/api/v1/payments",
        ]
      },
      {
        # TransactWriteItems listed for the same self-documenting reason as
        # product-api above — set_status_and_publish()'s transaction (orders
        # Update + order-outbox Put) is authorized via the UpdateItem/PutItem
        # grants on each table, not this action name; added anyway as
        # explicit, harmless intent.
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ]
        Resource = aws_dynamodb_table.orders.arn
      },
      {
        # Querying a GSI requires permission on the index ARN as well as the
        # table — customer-orders-index, saga-status-index, and
        # all-orders-index (the admin Customers & Orders view).
        Effect   = "Allow"
        Action   = "dynamodb:Query"
        Resource = "${aws_dynamodb_table.orders.arn}/index/*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
        ]
        Resource = aws_dynamodb_table.order_outbox.arn
      },
    ]
  })
}

# ---------- The functions ----------
#
# for_each over a map with STATIC keys, so Terraform can plan even though the
# values reference resources created here. The shape of a Lambda + log group
# + gateway integration is identical across the four; only the values differ,
# and duplicating the block four times invites the copy-paste error where one
# service quietly keeps another's environment.

locals {
  http_services = {
    product = {
      ecr_url  = aws_ecr_repository.product_service.repository_url
      role_arn = aws_iam_role.product_api.arn
      memory   = 256
      in_vpc   = true
      environment = {
        PRODUCTS_TABLE = aws_dynamodb_table.products.name
        OUTBOX_TABLE   = aws_dynamodb_table.product_outbox.name
        CORS_ORIGINS   = var.frontend_origin
      }
    }

    inventory = {
      ecr_url  = aws_ecr_repository.inventory_service.repository_url
      role_arn = aws_iam_role.inventory_api.arn
      memory   = 256
      in_vpc   = true
      environment = {
        INVENTORY_TABLE = aws_dynamodb_table.inventory.name
        CORS_ORIGINS    = var.frontend_origin
      }
    }

    payment = {
      ecr_url  = aws_ecr_repository.payment_service.repository_url
      role_arn = aws_iam_role.payment_api.arn
      memory   = 256
      in_vpc   = true
      environment = {
        PAYMENTS_TABLE   = aws_dynamodb_table.payments.name
        PAYMENT_PROVIDER = "mock"
        CORS_ORIGINS     = var.frontend_origin
      }
    }

    order = {
      ecr_url  = aws_ecr_repository.order_service.repository_url
      role_arn = aws_iam_role.order_api.arn
      # More memory than the others: the saga holds three synchronous
      # downstream calls open, and on Lambda memory also buys CPU, which
      # shortens the window in which it is billed for waiting.
      memory = 512

      # The ONE function deliberately left outside the VPC.
      #
      # The saga calls Inventory and Payment through the public API Gateway
      # URL. An execute-api interface endpoint cannot carry that traffic:
      # with private DNS it serves private REST APIs only, and HTTP APIs
      # (apigatewayv2) cannot be private at all. So reaching a service in
      # this same account from a private subnet would require a NAT gateway
      # (~£30/month) purely to leave AWS and come straight back.
      #
      # Rejected alternatives: a NAT gateway (cost, and it reintroduces the
      # internet egress path the whole design removes); making the gateway
      # a private REST API (the frontend could no longer reach it);
      # switching the saga to direct lambda:InvokeFunction (abandons the
      # local/deployed parity the public-URL decision was made for, and
      # would need its own interface endpoint anyway).
      #
      # The residual risk is honest and bounded: this function has internet
      # egress where the other six have none. It holds no credentials, and
      # its IAM role reaches only the orders tables.
      in_vpc = false
      environment = {
        ORDERS_TABLE       = aws_dynamodb_table.orders.name
        ORDER_OUTBOX_TABLE = aws_dynamodb_table.order_outbox.name
        CORS_ORIGINS       = var.frontend_origin

        # The saga calls the other services through the SAME public gateway
        # the frontend uses, so one code path serves local and deployed
        # (ADR-005 parity). The cost is an internet round trip between
        # services and a public surface that must be authenticated.
        PRODUCT_SERVICE_URL   = aws_apigatewayv2_api.main.api_endpoint
        INVENTORY_SERVICE_URL = aws_apigatewayv2_api.main.api_endpoint
        PAYMENT_SERVICE_URL   = aws_apigatewayv2_api.main.api_endpoint

        # Deliberately below the 30s function timeout: three sequential
        # downstream calls at 8s each still leave headroom for the saga's
        # own DynamoDB writes before Lambda kills the invocation. A timeout
        # here is what produces PAYMENT_UNKNOWN or STOCK_UNKNOWN (ADR-034),
        # so the value is a real correctness parameter, not a default.
        DOWNSTREAM_TIMEOUT_SECONDS = "8"
        SIGN_DOWNSTREAM_REQUESTS   = "true"
      }
    }
  }

  http_service_repositories = {
    product   = aws_ecr_repository.product_service.name
    inventory = aws_ecr_repository.inventory_service.name
    payment   = aws_ecr_repository.payment_service.name
    order     = aws_ecr_repository.order_service.name
  }
}

# A tag such as :latest is mutable, so Terraform cannot tell that a newly
# pushed image contains new application code. Resolving the tag to its digest
# makes the Lambda code version explicit and lets a plan safely deploy the
# image that was actually built and pushed before the apply.
data "aws_ecr_image" "http_service" {
  for_each = local.http_service_repositories

  repository_name = each.value
  image_tag       = "latest"
}

resource "aws_lambda_function" "http_service" {
  for_each = local.http_services

  function_name = "${local.prefix}-${each.key}-api"
  role          = each.value.role_arn
  package_type  = "Image"
  image_uri     = "${each.value.ecr_url}@${data.aws_ecr_image.http_service[each.key].image_digest}"

  timeout     = 30
  memory_size = each.value.memory

  environment {
    variables = each.value.environment
  }

  # Placed in the private subnets, with no route to the internet. The
  # dynamic block is what lets the Order function opt out — see the comment
  # on its in_vpc flag above.
  dynamic "vpc_config" {
    for_each = each.value.in_vpc ? [1] : []
    content {
      subnet_ids         = aws_subnet.private[*].id
      security_group_ids = [aws_security_group.lambda.id]
    }
  }

  # X-Ray, for the distributed trace across the saga (Task 7, ADR-009).
  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_log_group" "http_service" {
  for_each = local.service_route_prefixes

  # Declared explicitly rather than left to Lambda's auto-creation, which
  # produces a group with NO expiry and therefore unbounded storage cost.
  name              = "/aws/lambda/${aws_lambda_function.http_service[each.key].function_name}"
  retention_in_days = 14
}
