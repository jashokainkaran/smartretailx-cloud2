variable "environment" {
  description = "Deployment environment (dev, staging, production)"
  type        = string
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-west-1"
}

variable "project_name" {
  description = "Project name, used as a prefix on all resource names"
  type        = string
  default     = "smartretailx"
}

variable "frontend_origin" {
  description = "Override the origin allowed to call the APIs from a browser — e.g. http://localhost:5173 for a local frontend dev server talking to real AWS. Leave unset (null) to use the actual deployed CloudFront domain, computed automatically (local.frontend_origin in lambda_http_services.tf). Not '*', because every service sends allow_credentials, and a wildcard origin with credentials is rejected by browsers."
  type        = string
  default     = null
  nullable    = true
}

variable "dlq_max_receive_count" {
  description = "Failed processing attempts before a message moves to the DLQ"
  type        = number
  default     = 3
}

variable "notification_sender_email" {
  description = "The email address the Notification service sends receipts from. Must be verified in SES — AWS sends a confirmation link to this address that must be clicked before sending will work. While the SES account is in sandbox mode, the recipient of any test send must also be a verified address."
  type        = string
}

variable "billing_alert_email" {
  description = "Email address for AWS Budget and CloudWatch alarm notifications. Defaults to notification_sender_email when omitted, but can be set separately in dev.tfvars."
  type        = string
  default     = null
  nullable    = true
}

variable "monthly_budget_limit_usd" {
  description = "Monthly AWS account-cost alert threshold in USD. This is an alerting guardrail, not an automatic spending cap."
  type        = number
  default     = 5

  validation {
    condition     = var.monthly_budget_limit_usd > 0
    error_message = "monthly_budget_limit_usd must be greater than zero."
  }
}

variable "deployment_image_uris" {
  description = <<-EOT
    Exact immutable ECR image URIs, keyed by product/inventory/payment/order/
    outbox_relay/notification_service/websocket_service. CD supplies every
    service's currently deployed digest, replacing only the services it
    built in this release with their newly pushed digest. This prevents an
    unchanged service from falling back to a mutable :latest tag and being
    unintentionally upgraded or rolled back during another service's deploy.
    An omitted key resolves :latest only for local/manual bootstrap use.
  EOT
  type        = map(string)
  default     = {}
}

variable "ecr_image_retention_count" {
  description = "Number of ECR images retained per repository. Fifteen preserves several immutable CD releases for rollback without accumulating unlimited images."
  type        = number
  default     = 15

  validation {
    condition     = var.ecr_image_retention_count >= 5
    error_message = "ecr_image_retention_count must be at least 5."
  }
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to assume the CD role through OIDC."
  type        = string
  default     = "jashokainkaran/smartretailx-cloud2"
}

variable "github_deployment_environment" {
  description = "GitHub Environment name required by the CD workflow and OIDC trust policy."
  type        = string
  default     = "dev"
}

variable "github_actions_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN to reuse. Leave null for Terraform to create it."
  type        = string
  default     = null
  nullable    = true
}
