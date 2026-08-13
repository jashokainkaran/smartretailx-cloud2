import os

# Point the app at a SEPARATE test table BEFORE importing it.
os.environ["INVENTORY_TABLE"] = "InventoryTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"

import boto3
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config

client = TestClient(app)


@pytest.fixture(autouse=True)
def test_table():
    """Create a clean InventoryTest table before each test, delete it after."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    table = dynamodb.create_table(
        TableName="InventoryTest",
        KeySchema=[{"AttributeName": "product_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "product_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()

    # Seed one product with 100 units for tests to use.
    table.put_item(Item={
        "product_id": "p1",
        "available_quantity": 100,
        "reserved_quantity": 0,
    })

    yield

    table.delete()
    table.wait_until_not_exists()


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_get_stock():
    response = client.get("/api/v1/inventory/p1")
    assert response.status_code == 200
    body = response.json()
    assert body["available_quantity"] == 100
    assert body["reserved_quantity"] == 0


def test_get_stock_missing_returns_404():
    response = client.get("/api/v1/inventory/does-not-exist")
    assert response.status_code == 404


def test_reserve_reduces_available_and_raises_reserved():
    response = client.post("/api/v1/inventory/p1/reserve?quantity=30")
    assert response.status_code == 200
    body = response.json()
    assert body["available_quantity"] == 70
    assert body["reserved_quantity"] == 30


def test_reserve_more_than_available_is_rejected():
    # The core oversell-prevention behaviour, as a unit test.
    response = client.post("/api/v1/inventory/p1/reserve?quantity=1000")
    assert response.status_code == 409          # Conflict — insufficient stock
    # And stock must be UNCHANGED — a failed reserve moves nothing.
    stock = client.get("/api/v1/inventory/p1").json()
    assert stock["available_quantity"] == 100
    assert stock["reserved_quantity"] == 0


def test_release_returns_stock_to_available():
    client.post("/api/v1/inventory/p1/reserve?quantity=30")   # available 70, reserved 30
    response = client.post("/api/v1/inventory/p1/release?quantity=30")
    assert response.status_code == 200
    body = response.json()
    assert body["available_quantity"] == 100   # back on the shelf
    assert body["reserved_quantity"] == 0


def test_confirm_removes_reserved_without_changing_available():
    client.post("/api/v1/inventory/p1/reserve?quantity=30")   # available 70, reserved 30
    response = client.post("/api/v1/inventory/p1/confirm?quantity=30")
    assert response.status_code == 200
    body = response.json()
    assert body["available_quantity"] == 70    # unchanged — units already left available
    assert body["reserved_quantity"] == 0      # sold, gone


def test_reserve_zero_or_negative_is_rejected():
    assert client.post("/api/v1/inventory/p1/reserve?quantity=0").status_code == 400
    assert client.post("/api/v1/inventory/p1/reserve?quantity=-5").status_code == 400