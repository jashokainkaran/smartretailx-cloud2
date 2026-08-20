# Two roles, deliberately not one - the same distinction the rest of this
# project draws between infrastructure identity and application identity.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The task EXECUTION role: ECS's own identity for pulling the image from ECR
# and shipping logs to CloudWatch. Nothing to do with the application - it
# never touches DynamoDB or anything product-service-specific.
resource "aws_iam_role" "task_execution" {
  name               = "${local.prefix}-ecs-proof-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The task's OWN identity at runtime - what product-service's code actually
# runs as. Scoped to exactly what this proof exercises: /health calls
# describe_table, GET /api/v1/products calls Scan. No write actions granted
# - this proof exercises reads only, unlike the live Lambda role which also
# needs PutItem/UpdateItem/TransactWriteItems for the real write endpoints.
resource "aws_iam_role" "task" {
  name               = "${local.prefix}-ecs-proof-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "task" {
  name = "${local.prefix}-ecs-proof-task-policy"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:Scan",
        ]
        Resource = data.aws_dynamodb_table.products.arn
      },
    ]
  })
}
