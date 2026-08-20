# ---------------------------------------------------------------------------
# Frontend hosting and the public edge.
#
# One CloudFront distribution serves BOTH the React build and the API:
#
#   /*        -> S3 bucket (private, reachable only by this distribution)
#   /api/*    -> API Gateway
#
# Routing the API through the same distribution rather than exposing it
# separately buys three things:
#
#   1. CORS stops existing. Frontend and API share one origin, so there is
#      no preflight, no allow-credentials-with-wildcard problem, and the
#      frontend_origin variable becomes vestigial.
#   2. WAF becomes possible at all. WAFv2 attaches to CloudFront, ALB and
#      REST APIs — NOT to API Gateway HTTP APIs. Fronting the HTTP API with
#      CloudFront is the only way to put a web ACL in front of it without
#      rebuilding the gateway as a REST API.
#   3. One domain for Route 53 to point at later, rather than two.
#
# The cost is one extra hop of a few milliseconds, and that the API Gateway
# URL remains directly reachable unless separately restricted — acceptable
# now, and closed once the Cognito JWT authorizer applies at the gateway
# regardless of which path a request arrives by.
# ---------------------------------------------------------------------------

# ---------- The bucket ----------

# S3 bucket names are unique across ALL of AWS, not just this account — a
# plain "${local.prefix}-frontend" collided with a bucket some other account
# already owns. The account ID suffix is the standard fix: it costs nothing
# in readability (the bucket is never typed by hand, only referenced via
# aws_s3_bucket.frontend.id/.arn/.bucket_regional_domain_name below) and
# guarantees no other AWS account can ever collide with it.
data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "frontend" {
  bucket = "${local.prefix}-frontend-${data.aws_caller_identity.current.account_id}"
}

# Static website hosting is deliberately NOT enabled. That feature requires
# a publicly readable bucket and serves plain HTTP from a regional endpoint.
# Serving through CloudFront with Origin Access Control instead means the
# bucket can stay completely private and every response is HTTPS.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning is cheap insurance against the deployment that overwrites a
# working build with a broken one: the previous object is still there.
# Also the first half of CP-027's backup story for anything stored in S3.
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---------- Origin Access Control ----------
#
# OAC, not the legacy Origin Access Identity. OAC signs requests with SigV4,
# supports SSE-KMS, and is what AWS recommends for new distributions; OAI is
# retained only for existing ones.

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.prefix}-frontend-oac"
  description                       = "CloudFront to the private frontend bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The bucket grants read to the CloudFront SERVICE principal, narrowed by
# SourceArn to this one distribution. Without that condition any CloudFront
# distribution in any AWS account could read the bucket.
data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json
}

# ---------- WAF ----------
#
# Must be created in us-east-1 with scope CLOUDFRONT — a web ACL for a
# distribution is not a regional resource, whatever region the origin is in.

resource "aws_wafv2_web_acl" "main" {
  provider = aws.us_east_1

  name        = "${local.prefix}-web-acl"
  description = "Edge protection for the SmartRetailX frontend and API"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # AWS-managed baseline: the OWASP-style common protections — SQL and
  # command injection, path traversal, oversized bodies, known-bad user
  # agents. Managed rather than hand-written because the rules are updated
  # by AWS as techniques change, which no coursework project could keep up
  # with.
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  # Rate limiting per source IP. This is the layer that matters most for
  # this particular system: the checkout saga is expensive — three
  # downstream calls and several conditional writes per request — so an
  # unthrottled attacker costs money and holds stock in reservations. The
  # API Gateway stage throttle is an account-wide ceiling; this is per
  # client, which is the useful shape.
  rule {
    name     = "RateLimitPerIp"
    priority = 3

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitPerIp"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-web-acl"
    sampled_requests_enabled   = true
  }
}

# ---------- Distribution ----------

locals {
  s3_origin_id             = "frontend-s3"
  api_origin_id            = "api-gateway"
  product_images_origin_id = "product-images-s3"

  # The origin wants a bare hostname. api_endpoint is a full URL, so the
  # scheme has to come off.
  api_domain = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  comment             = "${local.prefix} frontend and API"
  default_root_object = "index.html"

  # PriceClass_100 is North America and Europe only. The full price class
  # adds Asia-Pacific and South America edges at roughly double the cost,
  # which is not justifiable for a system whose users are one marker and one
  # developer. Named explicitly so it reads as a decision rather than a
  # default (ADR-012).
  price_class = "PriceClass_100"

  web_acl_id = aws_wafv2_web_acl.main.arn

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    origin_id   = local.api_origin_id
    domain_name = local.api_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      # TLS 1.2 as the floor between CloudFront and the origin. 1.0 and 1.1
      # are deprecated and would fail a PCI assessment (ADR-007).
      origin_ssl_protocols = ["TLSv1.2"]
    }
  }

  origin {
    origin_id                = local.product_images_origin_id
    domain_name              = aws_s3_bucket.product_images.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.product_images.id
  }

  # --- Static assets ---
  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed "CachingOptimized".
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # --- The API ---
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed "CachingDisabled". Caching an API response here would be
    # actively wrong: stock levels change constantly, and a cached order
    # would show one customer another's data.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # AWS managed "AllViewerExceptHostHeader". Everything the viewer sent
    # is forwarded EXCEPT Host — which must stay as the origin's own
    # hostname, or API Gateway rejects the request as not matching any API.
    # Forwarding all headers including Host is the single most common
    # mistake in this configuration.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # --- Product images ---
  ordered_cache_behavior {
    path_pattern           = "/product-images/*"
    target_origin_id       = local.product_images_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed "CachingOptimized". Safe to cache aggressively: every
    # upload gets a fresh UUID key (app/images.py), so a URL either doesn't
    # exist yet or points at one immutable object forever — no
    # invalidation problem the way a mutable frontend deploy has.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Client-side routing. S3 has no notion of a route: a refresh on
  # /orders/abc asks the bucket for an object that does not exist and gets
  # 403 (because the bucket is private, so "not found" surfaces as "denied").
  # Both are rewritten to the SPA entry point with a 200, and React Router
  # resolves the path.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # The default *.cloudfront.net certificate. A custom domain would need
    # an ACM certificate in us-east-1 and a Route 53 zone — deferred with
    # CP-030 rather than half-done.
    #
    # minimum_protocol_version is deliberately NOT set to TLSv1.2_2021 here:
    # AWS only honours a custom minimum TLS version alongside a custom ACM
    # certificate. With cloudfront_default_certificate = true, AWS always
    # forces TLSv1 server-side and silently overrides anything else sent —
    # setting TLSv1.2_2021 here caused a perpetual apply/drift loop (every
    # apply pushed TLSv1.2_2021, AWS reset it to TLSv1, the next plan tried
    # again). Leaving it unset lets it default to what AWS actually enforces.
    cloudfront_default_certificate = true
  }
}
