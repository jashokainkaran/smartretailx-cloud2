variable "aws_region" {
  type    = string
  default = "eu-west-1"
}

variable "project_name" {
  type    = string
  default = "smartretailx"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "ecr_image_uri" {
  description = "The ECS-flavoured product-service image (built from Dockerfile.ecs, pushed via the AWS CLI — not managed by this or any Terraform root)."
  type        = string
  default     = "194680606132.dkr.ecr.eu-west-1.amazonaws.com/smartretailx-dev-product-service-ecs:latest"
}
