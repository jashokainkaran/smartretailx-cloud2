import os

# Comma-separated list of origins allowed to call this API (the frontend).
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "http://localhost:5173"
).split(",")

# Where DynamoDB lives. Locally this points at DynamoDB Local.
# In AWS we leave DYNAMODB_ENDPOINT unset, and boto3 finds real DynamoDB automatically.
DYNAMODB_ENDPOINT = os.environ.get("DYNAMODB_ENDPOINT")

# Which AWS region. Ireland, per our decision.
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")

# The name of our table.
PRODUCTS_TABLE = os.environ.get("PRODUCTS_TABLE", "Products")

# The EventBridge bus we publish domain events to.
# Unset locally means events are skipped (tests run without AWS).
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME")

# The outbox table for reliable event publication (ADR-020).
OUTBOX_TABLE = os.environ.get("OUTBOX_TABLE", "ProductOutbox")

# Used only by isolated pytest runs, which do not have an API Gateway event.
AUTH_TEST_MODE = os.environ.get("AUTH_TEST_MODE", "false").lower() == "true"

# Where admin-uploaded product images are stored (app/images.py) and the
# public base URL they're served back from — the same CloudFront domain the
# frontend itself is served from, routed to this bucket at /product-images/*.
# Unset locally, same convention as EVENT_BUS_NAME: the upload endpoint has
# nothing to presign against until these point at a deployed bucket.
PRODUCT_IMAGES_BUCKET = os.environ.get("PRODUCT_IMAGES_BUCKET", "")
PRODUCT_IMAGES_BASE_URL = os.environ.get("PRODUCT_IMAGES_BASE_URL", "")
