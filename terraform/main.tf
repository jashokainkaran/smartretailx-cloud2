terraform {
  required_version = ">= 1.10" # use_lockfile support (native S3 state locking)

  # Concrete values (bucket, key, region) are supplied at `terraform init`
  # time via backend.hcl — gitignored, since it's machine/environment
  # config, not a secret, but also not something worth committing (the
  # committed backend.hcl.example documents its shape). The bucket itself is
  # created once by terraform/bootstrap/, a deliberately separate root — see
  # that directory's own comment for why it can't live here.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront is a global service, and two of its dependencies are only
# addressable from us-east-1 regardless of where the rest of the stack runs:
# a WAF web ACL with scope = CLOUDFRONT, and an ACM certificate attached to a
# distribution. This alias exists solely for those. It is not a second
# deployment region — nothing with data in it is created here.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  prefix = "${var.project_name}-${var.environment}"
}
