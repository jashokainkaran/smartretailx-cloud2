import sys
import os

# Let this script import the product-service's app package.
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "services", "product-service")
sys.path.insert(0, os.path.abspath(SERVICE_DIR))

import boto3
from botocore.exceptions import ClientError
from app import config   # reuse the ONE source of truth for endpoint/region/table


dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=config.DYNAMODB_ENDPOINT,
    region_name=config.AWS_REGION,
    aws_access_key_id="local",
    aws_secret_access_key="local",
)


def create_products_table():
    existing = [t.name for t in dynamodb.tables.all()]
    if config.PRODUCTS_TABLE in existing:
        print(f"ℹ️  Table '{config.PRODUCTS_TABLE}' already exists — skipping.")
        return

    table = dynamodb.create_table(
        TableName=config.PRODUCTS_TABLE,
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()
    print(f"✅ Table '{config.PRODUCTS_TABLE}' created.")


if __name__ == "__main__":
    create_products_table()