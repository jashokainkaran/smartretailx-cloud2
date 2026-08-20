# ---------------------------------------------------------------------------
# One-time bootstrap: creates the S3 bucket that will hold the main
# terraform/ directory's remote state. Deliberately a separate root with its
# own (tiny, local) state — the main config can't manage the very bucket its
# own state is supposed to live inside without a chicken-and-egg problem.
#
# No DynamoDB lock table: this Terraform version (>= 1.10) supports native
# S3 state locking via the backend's own use_lockfile argument, which stores
# a small lock object in the same bucket instead of a separate table. One
# resource instead of two, for the same guarantee (two applies can't run
# against the same state at once).
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.10" # use_lockfile support (native S3 locking)

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
      ManagedBy   = "terraform-bootstrap"
      Purpose     = "terraform-state"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "${var.project_name}-${var.environment}-${data.aws_caller_identity.current.account_id}-terraform-state"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  # State must never be casually destroyed along with application resources.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "terraform_state_tls" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.terraform_state.arn,
      "${aws_s3_bucket.terraform_state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state_tls" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state_tls.json
}

output "terraform_state_bucket" {
  value = aws_s3_bucket.terraform_state.bucket
}
