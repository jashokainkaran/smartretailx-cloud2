resource "aws_ecs_cluster" "main" {
  name = "${local.prefix}-ecs-proof"
}

resource "aws_cloudwatch_log_group" "product_service" {
  name              = "/ecs/${local.prefix}-product-service-ecs-proof"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "product_service" {
  family                   = "${local.prefix}-product-service-ecs-proof"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # the only mode Fargate supports
  cpu                      = "256"    # 0.25 vCPU - plenty for a proof, not a load test
  memory                   = "512"    # 0.5 GB
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "product-service"
      image     = var.ecr_image_uri
      essential = true

      portMappings = [
        {
          containerPort = 8000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "PRODUCTS_TABLE", value = data.aws_dynamodb_table.products.name },
        { name = "OUTBOX_TABLE", value = "${local.prefix}-product-outbox" },
        { name = "AWS_REGION", value = var.aws_region },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.product_service.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "product-service"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "product_service" {
  name            = "${local.prefix}-product-service-ecs-proof"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.product_service.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.public.ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true # see security_groups.tf - reachable only via the ALB regardless
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.product_service.arn
    container_name   = "product-service"
    container_port   = 8000
  }

  # The service must exist before the listener can find anything healthy to
  # route to.
  depends_on = [aws_lb_listener.http]
}
