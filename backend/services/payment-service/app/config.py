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
PAYMENTS_TABLE = os.environ.get("PAYMENTS_TABLE", "Payments")

# Which payment provider implementation to use. "mock" for local dev and
# tests; a real integration would add its own value here (e.g. "stripe").
PAYMENT_PROVIDER = os.environ.get("PAYMENT_PROVIDER", "mock")

# Used only by isolated pytest runs, which do not have an API Gateway event.
AUTH_TEST_MODE = os.environ.get("AUTH_TEST_MODE", "false").lower() == "true"
