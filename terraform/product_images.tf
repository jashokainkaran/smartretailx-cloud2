# ---------------------------------------------------------------------------
# Product image storage. An admin's browser uploads directly to this bucket
# via a presigned S3 POST (not PUT — a POST policy is what lets S3 itself
# enforce a content-length-range, i.e. an actual server-side size cap; a
# presigned PUT has no such mechanism) that product-service generates. Image
# bytes never pass through Lambda or API Gateway, avoiding the HTTP API
# payload ceiling entirely. Reads are served through the SAME CloudFront
# distribution and WAF as everything else, at /product-images/*, rather than
# standing up a second distribution for one extra origin.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "product_images" {
  bucket = "${local.prefix}-product-images-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "product_images" {
  bucket = aws_s3_bucket.product_images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "product_images" {
  bucket = aws_s3_bucket.product_images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The presigned POST an admin's browser sends goes straight to S3, not
# through CloudFront, so the bucket itself — not the distribution — must
# answer the browser's request and allow it. Scoped to the one frontend
# origin, matching every other CORS_ORIGINS reference in this project.
resource "aws_s3_bucket_cors_configuration" "product_images" {
  bucket = aws_s3_bucket.product_images.id

  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = [local.frontend_origin]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# ---------- Origin Access Control ----------
# Same OAC pattern as the frontend bucket in hosting.tf: the bucket stays
# completely private, and only this one CloudFront distribution can read it.

resource "aws_cloudfront_origin_access_control" "product_images" {
  name                              = "${local.prefix}-product-images-oac"
  description                       = "CloudFront to the private product-images bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "product_images_bucket" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.product_images.arn}/*"]

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

resource "aws_s3_bucket_policy" "product_images" {
  bucket = aws_s3_bucket.product_images.id
  policy = data.aws_iam_policy_document.product_images_bucket.json
}
