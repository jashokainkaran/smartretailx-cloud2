import sys
import os

# Let this script import the inventory-service's app package.
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "services", "inventory-service")
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


def create_inventory_table():
    existing = [t.name for t in dynamodb.tables.all()]
    if config.INVENTORY_TABLE in existing:
        print(f"ℹ️  Table '{config.INVENTORY_TABLE}' already exists — skipping.")
        return

    table = dynamodb.create_table(
        TableName=config.INVENTORY_TABLE,
        KeySchema=[{"AttributeName": "product_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "product_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()
    print(f"✅ Table '{config.INVENTORY_TABLE}' created.")


if __name__ == "__main__":
    create_inventory_table()
