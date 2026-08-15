# ---------------------------------------------------------------------------
# Network
#
# Design position: the private subnets have NO route to the internet. There
# is no NAT gateway anywhere in this configuration, and that is deliberate
# rather than a cost compromise.
#
# Everything the application talks to is an AWS service — DynamoDB,
# EventBridge, and the other microservices via API Gateway. A NAT gateway
# would route that traffic out of AWS onto the public internet and straight
# back in, at roughly £30/month, for no gain. VPC endpoints keep it on the
# AWS backbone, cost a fraction of that, and mean an attacker who achieves
# code execution inside a Lambda has no egress path at all: no route to a
# command-and-control host, no route to exfiltrate to. That is the concrete
# form of the Zero Trust argument Task 3 asks about — the network denies by
# construction rather than by rule.
#
# Two kinds of endpoint, and the difference matters:
#   Gateway endpoint   — S3 and DynamoDB only. A route-table entry, not a
#                        device. Costs nothing.
#   Interface endpoint — everything else. An ENI in each subnet with a
#                        private IP, billed hourly per AZ.
#
# Public subnets and an internet gateway ARE created, unused by the
# serverless slice. They exist because the ECS Fargate target state
# (ADR-001) needs a public tier for its load balancer, and defining the
# network once for both deployment models is the point of designing it
# rather than growing it. Subnets, route tables and internet gateways are
# free; only NAT would cost, and there is none.
# ---------------------------------------------------------------------------

locals {
  # Two AZs, always the "a" and "b" suffix of whichever region this is
  # applied to — eu-west-1a/1b, ap-south-1a/1b, etc. Every standard AWS
  # region follows this naming, so no lookup is needed: the names are
  # derived directly from var.aws_region and switch automatically when the
  # region does (e.g. the ap-south-1 DR deployment, CP-031).
  #
  # Every subnet tier is spread across both, which is what makes the
  # multi-AZ claim true rather than asserted — a Lambda placed in these
  # subnets is scheduled across both, and DynamoDB replicates across three
  # regardless.
  azs = ["${var.aws_region}a", "${var.aws_region}b"]

  # Address plan. /24 per subnet is 251 usable addresses after AWS reserves
  # five in every subnet — far more than needed, but round numbers are worth
  # more than density here: the third octet alone tells you the tier.
  #
  #   10.0.1.x   / 10.0.2.x     private "app"  — Lambda ENIs
  #   10.0.101.x / 10.0.102.x   public  "web"  — ALB tier (ECS target state)
  #   10.0.201.x / 10.0.202.x   RESERVED for an isolated data tier if a
  #                             relational database is ever introduced.
  #                             Not created: DynamoDB is a managed service
  #                             reached through a gateway endpoint and has
  #                             no presence in the VPC.
  #
  # The last octet pair maps to the AZ index, so 10.0.1.x and 10.0.101.x are
  # always the same availability zone.
  private_cidrs = ["10.0.1.0/24", "10.0.2.0/24"]
  public_cidrs  = ["10.0.101.0/24", "10.0.102.0/24"]

  # A Lambda with a vpc_config attaches an elastic network interface to the
  # subnet, and cannot do so without these permissions. Omitting them is a
  # confusing failure: the function is created successfully and then fails
  # at invocation, because the ENI attach happens on cold start rather than
  # at deploy time.
  vpc_access_statement = {
    Effect = "Allow"
    Action = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
    ]
    # Not scopeable to a resource: DescribeNetworkInterfaces does not
    # support resource-level permissions, and the interfaces being created
    # do not exist yet to be named. This is the same wildcard AWS ships in
    # its own AWSLambdaVPCAccessExecutionRole managed policy.
    Resource = "*"
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  # Both are REQUIRED for interface endpoints. private_dns_enabled on an
  # endpoint works by overriding the service's public DNS name inside the
  # VPC, which needs the VPC's own DNS resolution and hostnames enabled.
  # Without them, boto3 resolves the public IP and the call leaves for an
  # internet route that does not exist — it hangs until the socket times
  # out rather than failing fast.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.prefix}-vpc" }
}

# ---------- Subnets ----------

resource "aws_subnet" "private" {
  count = length(local.private_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    # Named for what runs in it, not just where it is: "private-app" says
    # the tier and its purpose, and the AZ suffix says which failure domain.
    Name = "${local.prefix}-private-app-${local.azs[count.index]}"
    Tier = "private"
    Role = "application"

    # Not a per-service subnet — all six in-VPC Lambdas share this tier and
    # its one security group (aws_security_group.lambda). Listed here so the
    # subnet is self-documenting about what actually runs in it, without
    # implying a network split that doesn't exist. Service isolation is
    # enforced by IAM role + DynamoDB table (database-per-service), not by
    # subnet boundary.
    Services = "product-api,inventory-api,payment-api,outbox-relay,order-outbox-relay,inventory-consumer"
  }
}

resource "aws_subnet" "public" {
  count = length(local.public_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.azs[count.index]

  # Explicitly false. Nothing in the serverless slice runs here, and a
  # subnet that hands out public IPs by default is how a resource ends up
  # internet-facing without anyone deciding it should be.
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.prefix}-public-web-${local.azs[count.index]}"
    Tier = "public"
    Role = "load-balancer"

    # Reserved, not yet in use: no service is deployed here in the
    # serverless slice. This tier exists for the ECS Fargate target state's
    # load balancer (ADR-001).
    Services = "reserved-ecs-fargate-alb"
  }
}

# ---------- Routing ----------

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.prefix}-public-web-rt" }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# The private route table has NO default route. Its only entries are the
# VPC's own local route (implicit) and the DynamoDB gateway endpoint added
# below. Anything not addressed to the VPC or to DynamoDB has nowhere to go.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-private-app-rt" }
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------- Security groups ----------

# AWS publishes the IP ranges of its gateway-endpoint services as managed
# prefix lists. Referencing the list rather than hardcoding CIDRs means the
# rule follows AWS's ranges as they change, and stays readable.
data "aws_ec2_managed_prefix_list" "dynamodb" {
  name = "com.amazonaws.${var.aws_region}.dynamodb"
}

resource "aws_security_group" "lambda" {
  name        = "${local.prefix}-lambda-sg"
  description = "Lambda functions in private subnets"
  vpc_id      = aws_vpc.main.id

  # No ingress rule at all. Nothing connects TO a Lambda over the network —
  # API Gateway and SQS invoke it through the Lambda service, not through
  # the VPC. An empty ingress block is not an oversight; it is the point.

  # Egress is 443 only, and only to two destinations.
  #
  # First: inside the VPC, for the interface endpoint ENIs.
  egress {
    description = "HTTPS to interface endpoints"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  # Second: DynamoDB. This rule is easy to get wrong and the failure is
  # total. Traffic through a GATEWAY endpoint is addressed to DynamoDB's
  # own public IP range — the endpoint changes the ROUTE, not the
  # destination address. A security group allowing egress only to
  # 10.0.0.0/16 therefore blocks every database call in the system while
  # looking tighter than it is. The managed prefix list is the correct
  # destination, and is still far narrower than 0.0.0.0/0.
  egress {
    description     = "HTTPS to DynamoDB via the gateway endpoint"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.dynamodb.id]
  }

  # No port 80 anywhere: every AWS API is HTTPS, so plaintext has no
  # legitimate destination from here.

  tags = { Name = "${local.prefix}-lambda-sg" }
}

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.prefix}-vpc-endpoints-sg"
  description = "Interface endpoint ENIs"
  vpc_id      = aws_vpc.main.id

  # Ingress restricted to the Lambda security group by ID, not by CIDR.
  # A CIDR rule would admit anything that happened to be in the subnet
  # range; referencing the security group means only resources actually
  # carrying that group can connect, regardless of address.
  ingress {
    description     = "HTTPS from Lambda functions"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  tags = { Name = "${local.prefix}-vpc-endpoints-sg" }
}

# ---------- VPC endpoints ----------

# Gateway endpoint. Free, and implemented as a route-table entry rather
# than an ENI — which is why it attaches to the route table and not to a
# subnet or a security group.
resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${local.prefix}-dynamodb-endpoint" }
}

# Interface endpoints. Billed hourly per AZ, so there is exactly one: the
# only non-DynamoDB AWS service any in-VPC function actually calls.
#
#   events — the two outbox relays publish to EventBridge.
#
# Deliberately absent, and each for a specific reason:
#
#   sqs         — the inventory consumer is TRIGGERED by SQS but never
#                 calls it. The Lambda service polls the queue from outside
#                 the VPC and invokes the function with the messages
#                 already in hand. An endpoint would cost money to carry no
#                 traffic.
#
#   execute-api — this was in an earlier draft and removed on checking the
#                 constraint. An execute-api interface endpoint with
#                 private DNS serves PRIVATE REST APIs only; enabling it
#                 makes public API Gateway endpoints unreachable from the
#                 VPC rather than reachable, and API Gateway HTTP APIs
#                 (apigatewayv2) cannot be private at all. So it could not
#                 carry the saga's calls even in principle. This is why the
#                 Order function stays outside the VPC — see
#                 lambda_http_services.tf.
#
#   logs        — not required. A Lambda's log output is collected by the
#                 Lambda service itself, outside the customer VPC, not
#                 written over the function's own ENI.
locals {
  interface_endpoint_services = {
    events = "com.amazonaws.${var.aws_region}.events"
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoint_services

  vpc_id            = aws_vpc.main.id
  service_name      = each.value
  vpc_endpoint_type = "Interface"

  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.vpc_endpoints.id]

  # Overrides the service's public DNS name inside the VPC so it resolves
  # to the endpoint's private IP. This is what makes the change invisible
  # to the application: boto3 and httpx keep using the normal AWS hostname
  # and no code changes at all.
  private_dns_enabled = true

  tags = { Name = "${local.prefix}-${each.key}-endpoint" }
}

# ---------- Flow logs ----------
#
# The record of what traffic actually crossed the network. Two reasons this
# is worth its keep:
#
#   Security (Task 3) — anomalous egress is invisible without it. A
#   compromised function attempting to reach an external host produces a
#   REJECT entry here and nothing anywhere else.
#
#   Evidence — flow logs showing only endpoint traffic and no attempts at a
#   public destination PROVE the no-internet-egress design. A route table
#   with an absence in it merely asserts it.
#
# traffic_type ALL rather than REJECT: accepted traffic is what shows the
# endpoints are being used, which is the affirmative half of the claim.

resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  name              = "/aws/vpc/${local.prefix}-flow-logs"
  retention_in_days = 14
}

resource "aws_iam_role" "vpc_flow_logs" {
  name = "${local.prefix}-vpc-flow-logs-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      # Note the principal: this role is assumed by the VPC flow logs
      # service itself, not by Lambda. A copy-pasted lambda.amazonaws.com
      # trust policy here fails silently — the flow log is created and
      # never delivers a record.
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "vpc_flow_logs" {
  name = "${local.prefix}-vpc-flow-logs-policy"
  role = aws_iam_role.vpc_flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.vpc_flow_logs.arn}:*"
    }]
  })
}

resource "aws_flow_log" "main" {
  vpc_id = aws_vpc.main.id

  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.vpc_flow_logs.arn
  iam_role_arn         = aws_iam_role.vpc_flow_logs.arn

  tags = { Name = "${local.prefix}-flow-logs" }
}

# ---------- Network ACLs ----------
#
# A second, stateless layer beneath the security groups. Security groups are
# stateful — a reply to an allowed outbound connection is permitted
# automatically — so they already deny by default and do most of the work.
# NACLs are added for defence in depth: they apply at the SUBNET boundary
# rather than the interface, so they still constrain anything later placed
# in these subnets whose security group is misconfigured.
#
# Being stateless is what makes them easy to get wrong. Return traffic is
# NOT implied: every allowed outbound connection needs a matching inbound
# rule for the ephemeral port range the remote end replies to.
#
# The one that catches people: DynamoDB traffic through a GATEWAY endpoint
# is addressed to DynamoDB's public IP range, not to anything inside the
# VPC. Restricting egress to 10.0.0.0/16 would look tighter and would break
# every database call in the system. Hence 443 to 0.0.0.0/0 — still a real
# constraint, because every other port and protocol is denied.

resource "aws_network_acl" "private" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = aws_subnet.private[*].id

  # --- Outbound ---
  egress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidr_block = "0.0.0.0/0"
  }

  # Return traffic for connections initiated INTO this subnet (the
  # interface endpoint ENIs answering a Lambda in the other AZ's subnet).
  egress {
    rule_no    = 110
    action     = "allow"
    protocol   = "tcp"
    from_port  = 1024
    to_port    = 65535
    cidr_block = "10.0.0.0/16"
  }

  # --- Inbound ---
  # Replies to outbound connections. AWS services answer on an ephemeral
  # port, and because the ACL is stateless this must be stated explicitly.
  ingress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 1024
    to_port    = 65535
    cidr_block = "0.0.0.0/0"
  }

  # Lambda in one AZ's subnet reaching an endpoint ENI in the other's.
  # Same-subnet traffic never crosses a NACL; cross-subnet traffic does.
  ingress {
    rule_no    = 110
    action     = "allow"
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidr_block = "10.0.0.0/16"
  }

  # Everything else is denied by the implicit final rule. Notably: no
  # inbound on 22, 3389 or any other management port, from anywhere.

  tags = { Name = "${local.prefix}-private-app-nacl" }
}

resource "aws_network_acl" "public" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = aws_subnet.public[*].id

  # Nothing runs here yet — these subnets exist for the ECS Fargate target
  # state's load balancer tier (ADR-001). The rules describe what that tier
  # would need: HTTP/HTTPS in from anywhere, ephemeral replies out.
  ingress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidr_block = "0.0.0.0/0"
  }

  ingress {
    rule_no    = 110
    action     = "allow"
    protocol   = "tcp"
    from_port  = 80
    to_port    = 80
    cidr_block = "0.0.0.0/0"
  }

  ingress {
    rule_no    = 120
    action     = "allow"
    protocol   = "tcp"
    from_port  = 1024
    to_port    = 65535
    cidr_block = "0.0.0.0/0"
  }

  egress {
    rule_no    = 100
    action     = "allow"
    protocol   = "-1"
    from_port  = 0
    to_port    = 0
    cidr_block = "0.0.0.0/0"
  }

  tags = { Name = "${local.prefix}-public-web-nacl" }
}
