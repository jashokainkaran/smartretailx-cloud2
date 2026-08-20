resource "aws_ecr_repository" "product_service" {
  name                 = "${local.prefix}-product-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "outbox_relay" {
  name                 = "${local.prefix}-outbox-relay"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "product_service" {
  repository = aws_ecr_repository.product_service.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the configured number of recent images for rollback"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "outbox_relay" {
  repository = aws_ecr_repository.outbox_relay.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the configured number of recent images for rollback"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}