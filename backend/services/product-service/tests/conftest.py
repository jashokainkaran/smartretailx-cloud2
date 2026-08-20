"""Shared, import-order-independent test configuration for Product service."""

import os

import boto3
import pytest

os.environ.setdefault("PRODUCTS_TABLE", "ProductsTest")
os.environ.setdefault("OUTBOX_TABLE", "ProductOutboxTest")
os.environ.setdefault("DYNAMODB_ENDPOINT", "http://localhost:8000")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-west-1")
os.environ.setdefault("AUTH_TEST_MODE", "true")


@pytest.fixture(scope="session", autouse=True)
def remove_stale_test_tables():
    client = boto3.client(
        "dynamodb",
        endpoint_url=os.environ["DYNAMODB_ENDPOINT"],
        region_name=os.environ["AWS_DEFAULT_REGION"],
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    for table_name in (os.environ["PRODUCTS_TABLE"], os.environ["OUTBOX_TABLE"]):
        try:
            client.delete_table(TableName=table_name)
            client.get_waiter("table_not_exists").wait(TableName=table_name)
        except client.exceptions.ResourceNotFoundException:
            pass
    yield
