# Standard two-layer pattern: nothing reaches the task except through the
# ALB. The task's own security group accepts traffic ONLY from the ALB's
# security group — never a raw CIDR — so the app port is never directly
# internet-reachable even though the task itself sits in a public subnet.

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-ecs-alb-sg"
  description = "Internet-facing ALB for the ECS/Fargate product-service proof"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    description = "HTTP from anywhere - this is a temporary proof, no ACM cert/HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "task" {
  name        = "${local.prefix}-ecs-task-sg"
  description = "Fargate task for the product-service ECS proof - reachable only from the ALB"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    description     = "App port, from the ALB security group only"
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Outbound needs the internet: the task sits in a PUBLIC subnet with a
  # public IP (main.tf's comment explains why - no NAT gateway or ECR/logs
  # VPC interface endpoints exist in this account, and adding them just for
  # a temporary proof would cost ~$22/month for something torn down after
  # screenshots). This is what actually reaches ECR to pull the image and
  # CloudWatch Logs to ship logs.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
