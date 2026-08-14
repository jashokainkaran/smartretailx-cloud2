import sys
import os

# Let this script import the payment-service's app package.
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "services", "payment-service")
sys.path.insert(0, os.path.abspath(SERVICE_DIR))

import boto3
from botocore.exceptions import ClientError
from app import config   # reuse the ONE source of truth for endpoint/region/table


# These scripts are local-only tooling — AWS tables are provisioned by
# Terraform. The service's config.DYNAMODB_ENDPOINT defaults to None so
# that the service itself reaches real AWS in production; a script
# inheriting that None would silently target real AWS too, and fail with
# an unrecognised-client error since it still sends dummy credentials. The
# endpoint here deliberately defaults to DynamoDB Local instead.
DYNAMODB_LOCAL_ENDPOINT = os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000")

dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=DYNAMODB_LOCAL_ENDPOINT,
    region_name=config.AWS_REGION,
    aws_access_key_id="local",
    aws_secret_access_key="local",
)


def create_payments_table():
    existing = [t.name for t in dynamodb.tables.all()]
    if config.PAYMENTS_TABLE in existing:
        print(f"ℹ️  Table '{config.PAYMENTS_TABLE}' already exists — skipping.")
        return

    table = dynamodb.create_table(
        TableName=config.PAYMENTS_TABLE,
        KeySchema=[{"AttributeName": "payment_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "payment_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()
    print(f"✅ Table '{config.PAYMENTS_TABLE}' created.")


if __name__ == "__main__":
    create_payments_table()
