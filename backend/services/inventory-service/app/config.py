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
INVENTORY_TABLE = os.environ.get("INVENTORY_TABLE", "Inventory")