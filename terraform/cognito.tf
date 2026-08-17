# -----------------------------------------------------------------------------
# Cognito authentication and RBAC
#
# The user pool, browser client, domain, and two groups were created in the
# AWS Console so that the project could be tested immediately. The import
# blocks below bring those exact resources under Terraform management; they do
# not create another pool or delete the existing users.
# -----------------------------------------------------------------------------

locals {
  cognito_user_pool_id  = "eu-west-1_dvHPkvsnQ"
  cognito_domain_prefix = "smartretailx-dev-jashok"
  cognito_web_client_id = "446p56998av63mo3j5gg63u774"
}

data "aws_caller_identity" "cognito" {}

resource "aws_cognito_user_pool" "main" {
  # This is the existing console-created pool name shown in its breadcrumb.
  name = "User pool - wx9eys"

  # The console-created pool has deletion protection ON. Pin it explicitly;
  # otherwise Terraform's default would silently turn it OFF on apply.
  deletion_protection = "ACTIVE"

  # Email is the account identifier selected during console setup.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Cognito invokes this only after a person has verified a self-service
  # registration. The Lambda assigns the customers group, never admin.
  lambda_config {
    post_confirmation = aws_lambda_function.cognito_post_confirmation.arn
  }

  # Console-created pools contain several provider-managed/default settings.
  # Keep them unchanged during the initial import; after the import plan is
  # reviewed, each setting can be deliberately made explicit in Terraform.
  lifecycle {
    # Losing a user pool can mean losing user identities. If a future edit
    # would require replacement, stop with a clear Terraform error instead
    # of deleting the pool or its configuration.
    prevent_destroy = true

    ignore_changes = [
      account_recovery_setting,
      admin_create_user_config,
      device_configuration,
      email_configuration,
      mfa_configuration,
      password_policy,
      schema,
      user_attribute_update_settings,
      user_pool_add_ons,
      username_configuration,
      verification_message_template,
    ]
  }

  depends_on = [aws_lambda_permission.cognito_post_confirmation]
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "smartretailx-dev-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # This is the public React SPA client. A browser cannot keep a client secret,
  # so Cognito is configured with no secret and authorisation-code flow.
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = distinct([var.frontend_origin, "https://${aws_cloudfront_distribution.main.domain_name}"])
  logout_urls                          = distinct([var.frontend_origin, "https://${aws_cloudfront_distribution.main.domain_name}"])
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH"]

  # Match the existing client settings exactly; this avoids Terraform removing
  # the explicit unit labels even though their effective values are unchanged.
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  lifecycle {
    # A replacement would invalidate browser authentication, so require an
    # explicit human decision rather than allowing an accidental destroy.
    prevent_destroy = true

  }
}

resource "aws_cognito_user_pool_domain" "main" {
  # For a Cognito-managed domain, Terraform needs only the prefix, not the
  # full https://...amazoncognito.com URL.
  domain       = local.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cognito_user_group" "customers" {
  name         = "customers"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Standard SmartRetailX customer account"
  precedence   = 10

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "SmartRetailX administrator — manages products, stock and orders"
  precedence   = 1

  lifecycle {
    prevent_destroy = true
  }
}

# The archive provider creates the ZIP used by the Lambda from the small
# Python handler above. The ZIP is ignored by Git because Terraform can build
# it again from source whenever needed.
data "archive_file" "cognito_post_confirmation" {
  type        = "zip"
  source_file = "${path.module}/../backend/functions/cognito-post-confirmation/handler.py"
  output_path = "${path.module}/cognito-post-confirmation.zip"
}

resource "aws_iam_role" "cognito_post_confirmation" {
  name = "${local.prefix}-cognito-post-confirmation-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "cognito_post_confirmation" {
  name = "${local.prefix}-cognito-post-confirmation-policy"
  role = aws_iam_role.cognito_post_confirmation.id

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
        # The trigger may add users only to groups inside this one user pool.
        # It has no permission to create users, read passwords, or grant IAM.
        Effect   = "Allow"
        Action   = "cognito-idp:AdminAddUserToGroup"
        Resource = aws_cognito_user_pool.main.arn
      },
    ]
  })
}

resource "aws_lambda_function" "cognito_post_confirmation" {
  function_name = "${local.prefix}-cognito-post-confirmation"
  role          = aws_iam_role.cognito_post_confirmation.arn
  runtime       = "python3.12"
  handler       = "handler.handler"
  filename      = data.archive_file.cognito_post_confirmation.output_path

  source_code_hash = data.archive_file.cognito_post_confirmation.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      # Literal rather than a resource reference: the user pool must be able
      # to register its trigger before Terraform imports the pre-existing
      # group, so this avoids a dependency cycle during the first apply.
      CUSTOMER_GROUP_NAME = "customers"
    }
  }
}

resource "aws_lambda_permission" "cognito_post_confirmation" {
  statement_id  = "AllowCognitoPostConfirmation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_post_confirmation.function_name
  principal     = "cognito-idp.amazonaws.com"

  # This literal ARN lets Terraform create the permission before it updates
  # the imported user pool's trigger configuration.
  source_arn = "arn:aws:cognito-idp:${var.aws_region}:${data.aws_caller_identity.cognito.account_id}:userpool/${local.cognito_user_pool_id}"
}

# Import the resources that already exist in AWS. Terraform 1.5+ carries out
# these imports during plan/apply, giving us a reviewable single operation.
import {
  to = aws_cognito_user_pool.main
  id = "eu-west-1_dvHPkvsnQ"
}

import {
  to = aws_cognito_user_pool_client.web
  id = "eu-west-1_dvHPkvsnQ/446p56998av63mo3j5gg63u774"
}

import {
  to = aws_cognito_user_pool_domain.main
  id = "smartretailx-dev-jashok"
}

import {
  to = aws_cognito_user_group.customers
  id = "eu-west-1_dvHPkvsnQ/customers"
}

import {
  to = aws_cognito_user_group.admin
  id = "eu-west-1_dvHPkvsnQ/admin"
}
