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

variable "dlq_max_receive_count" {
  description = "Failed processing attempts before a message moves to the DLQ"
  type        = number
  default     = 3
}