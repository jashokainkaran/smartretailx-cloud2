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


def create_order_outbox_table():
    """
    Create the local order outbox table.

    Deliberately simpler than its Terraform counterpart (terraform/
    order_outbox.tf), which additionally configures a DynamoDB Stream, the
    sparse pending-index GSI, a TTL attribute and point-in-time recovery.
    None of those are reproducible or useful against DynamoDB Local:
    Streams have no consumer locally (the relay is a Lambda, ADR-020), TTL
    expiry is never processed, and PITR does not exist. The local table
    exists so the Order service can write outbox records during development
    and its saga can be exercised end to end; the relay side of the flow is
    only ever proven on AWS.
    """
    existing = [t.name for t in dynamodb.tables.all()]
    if config.ORDER_OUTBOX_TABLE in existing:
        print(f"ℹ️  Table '{config.ORDER_OUTBOX_TABLE}' already exists — skipping.")
        return

    table = dynamodb.create_table(
        TableName=config.ORDER_OUTBOX_TABLE,
        KeySchema=[{"AttributeName": "event_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "event_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()
    print(f"✅ Table '{config.ORDER_OUTBOX_TABLE}' created.")


if __name__ == "__main__":
    create_order_outbox_table()
