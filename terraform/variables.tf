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
  description = "Origin allowed to call the APIs from a browser. Set to the CloudFront domain once the frontend is deployed; localhost during development. Not '*', because every service sends allow_credentials, and a wildcard origin with credentials is rejected by browsers."
  type        = string
  default     = "http://localhost:5173"
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