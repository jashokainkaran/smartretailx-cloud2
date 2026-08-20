# ---------------------------------------------------------------------------
# ECS/Fargate container-orchestration proof for CP-032 (COMP60010/ECDWA2's
# explicit "EKS or ECS Fargate" requirement, named separately from Lambda).
#
# This is a DELIBERATELY SEPARATE Terraform root, not more files inside the
# main terraform/ directory. If it lived there, it would be picked up by
# every future `terraform apply` run for anything else in this project —
# the ALB and Fargate service would get created (or recreated) as a side
# effect of unrelated work. Living in its own root with its own state means
# it is only ever touched by a deliberate `terraform apply` run from THIS
# directory. terraform/bootstrap/ already establishes this exact pattern for
# the same reason.
#
# It reads the existing product-service infrastructure (VPC, public subnets,
# DynamoDB table) via data sources rather than hardcoded IDs, so it stays
# correct if those are ever recreated, and deploys the SAME FastAPI
# application code as the live Lambda — packaged with
# backend/services/product-service/Dockerfile.ecs (a plain Uvicorn process,
# not the Lambda Runtime Interface Client image) rather than a rewrite.
#
# This is a temporary, cost-controlled proof: built, evidenced (screenshots
# of the cluster/service/task/target-group health plus a live curl against
# the ALB), then torn down with `terraform destroy` run from this directory.
# It does NOT touch, replace, or depend on the live Lambda/API Gateway path.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform-ecs-proof"
      Purpose     = "CP-032 container-orchestration proof - temporary"
    }
  }
}

locals {
  prefix = "${var.project_name}-${var.environment}"
}

# ---------- Existing infrastructure, read-only ----------

data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["${local.prefix}-vpc"]
  }
}

# The two public subnets were reserved for exactly this purpose — tagged
# Services=reserved-ecs-fargate-alb, Role=load-balancer, Tier=public — when
# the network was first built (terraform/network.tf, main state). Reused
# here rather than creating new ones.
data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }

  tags = {
    Tier = "public"
  }
}

data "aws_dynamodb_table" "products" {
  name = "${local.prefix}-products"
}
