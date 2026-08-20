"""Shared, import-order-independent test configuration for Inventory service."""

import os

import boto3
import pytest

os.environ.setdefault("INVENTORY_TABLE", "InventoryTest")
os.environ.setdefault("DYNAMODB_ENDPOINT", "http://localhost:8000")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-west-1")
os.environ.setdefault("AUTH_TEST_MODE", "true")


@pytest.fixture(scope="session", autouse=True)
def remove_stale_test_table():
    client = boto3.client(
        "dynamodb",
        endpoint_url=os.environ["DYNAMODB_ENDPOINT"],
        region_name=os.environ["AWS_DEFAULT_REGION"],
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    try:
        client.delete_table(TableName=os.environ["INVENTORY_TABLE"])
        client.get_waiter("table_not_exists").wait(TableName=os.environ["INVENTORY_TABLE"])
    except client.exceptions.ResourceNotFoundException:
        pass
    yield
