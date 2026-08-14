import sys
import os

# Let this script import the order-service's app package.
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "services", "order-service")
sys.path.insert(0, os.path.abspath(SERVICE_DIR))

import boto3
from app import config   # reuse the ONE source of truth for endpoint/region/table

# These scripts are local-only tooling — AWS tables are provisioned by
# Terraform. The service's config.DYNAMODB_ENDPOINT defaults to None so
# that the service itself reaches real AWS in production; a script
# inheriting that None would silently target real AWS too. The endpoint
# here deliberately defaults to DynamoDB Local instead.
DYNAMODB_LOCAL_ENDPOINT = os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000")

dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=DYNAMODB_LOCAL_ENDPOINT,
    region_name=config.AWS_REGION,
    aws_access_key_id="local",
    aws_secret_access_key="local",
)


def create_orders_table():
    existing = [t.name for t in dynamodb.tables.all()]
    if config.ORDERS_TABLE in existing:
        print(f"ℹ️  Table '{config.ORDERS_TABLE}' already exists — skipping.")
        return

    table = dynamodb.create_table(
        TableName=config.ORDERS_TABLE,
        KeySchema=[
            {"AttributeName": "order_id", "KeyType": "HASH"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "order_id", "AttributeType": "S"},
            {"AttributeName": "customer_id", "AttributeType": "S"},
            {"AttributeName": "created_at", "AttributeType": "S"},
            {"AttributeName": "saga_status", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "customer-orders-index",
                "KeySchema": [
                    {"AttributeName": "customer_id", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
            {
                "IndexName": "saga-status-index",
                "KeySchema": [
                    {"AttributeName": "saga_status", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()
    print(f"✅ Table '{config.ORDERS_TABLE}' created with 2 GSIs.")


if __name__ == "__main__":
    create_orders_table()