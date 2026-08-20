resource "aws_lb" "main" {
  name               = "${local.prefix}-ecs-proof-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.public.ids

  # This is a temporary proof torn down right after evidence is captured -
  # deletion protection would just be one more manual step to remember and
  # undo before `terraform destroy` can succeed.
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "product_service" {
  name        = "${local.prefix}-ecs-proof-tg"
  port        = 8000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.main.id
  target_type = "ip" # required for Fargate - tasks have no persistent instance ID

  health_check {
    path                = "/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.product_service.arn
  }
}
