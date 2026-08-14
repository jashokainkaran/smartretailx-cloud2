import os

# Point the app at a SEPARATE test table BEFORE importing it.
# This must happen before "from app.main import app" so config picks it up.
os.environ["PRODUCTS_TABLE"] = "ProductsTest"
os.environ["OUTBOX_TABLE"] = "ProductOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"

import boto3
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config

client = TestClient(app)


# ---- Test setup: create a fresh test table, tear it down after ----

@pytest.fixture(autouse=True)
def test_table():
    """Create a clean ProductsTest table before each test, delete it after."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )

    # Create the throwaway table.
    table = dynamodb.create_table(
        TableName="ProductsTest",
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()

    # Create the throwaway outbox table.
    outbox_table = dynamodb.create_table(
        TableName="ProductOutboxTest",
        KeySchema=[{"AttributeName": "event_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "event_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    outbox_table.wait_until_exists()

    yield   # <-- the test runs at this point

    # Cleanup: delete the tables so the next test starts clean.
    table.delete()
    table.wait_until_not_exists()

    outbox_table.delete()
    outbox_table.wait_until_not_exists()


# ---- The actual tests ----

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_product():
    payload = {
        "name": "Test Widget",
        "description": "A widget for testing",
        "price": 19.99,
        "category": "Testing",
    }
    response = client.post("/api/v1/products", json=payload)

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Test Widget"
    assert body["price"] == "19.99"
    assert "id" in body           # server generated an id
    assert len(body["id"]) > 0


def test_get_product():
    # First create one...
    created = client.post("/api/v1/products", json={
        "name": "Fetch Me",
        "description": "x",
        "price": 5.0,
        "category": "Testing",
    }).json()

    # ...then fetch it back by id.
    response = client.get(f"/api/v1/products/{created['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


def test_get_missing_product_returns_404():
    response = client.get("/api/v1/products/does-not-exist")
    assert response.status_code == 404


def test_update_product_changes_only_supplied_fields():
    created = client.post("/api/v1/products", json={
        "name": "Original Name",
        "description": "Original description",
        "price": 10.00,
        "category": "Testing",
    }).json()

    response = client.put(f"/api/v1/products/{created['id']}", json={
        "price": "25.00",
    })

    assert response.status_code == 200
    body = response.json()
    assert body["price"] == "25.00"
    assert body["name"] == "Original Name"
    assert body["description"] == "Original description"
    assert body["category"] == "Testing"


def test_update_missing_product_returns_404():
    response = client.put("/api/v1/products/does-not-exist", json={"name": "New Name"})
    assert response.status_code == 404


def test_deactivate_then_list_excludes_by_default():
    created = client.post("/api/v1/products", json={
        "name": "Deactivate Me",
        "description": "x",
        "price": 1.0,
        "category": "Testing",
    }).json()

    deactivate_response = client.patch(f"/api/v1/products/{created['id']}/deactivate")
    assert deactivate_response.status_code == 200
    assert deactivate_response.json()["active"] is False

    listing = client.get("/api/v1/products").json()
    ids = [item["id"] for item in listing["items"]]
    assert created["id"] not in ids


def test_deactivate_then_list_include_inactive_shows_it():
    created = client.post("/api/v1/products", json={
        "name": "Still Findable",
        "description": "x",
        "price": 1.0,
        "category": "Testing",
    }).json()

    client.patch(f"/api/v1/products/{created['id']}/deactivate")

    listing = client.get("/api/v1/products?include_inactive=true").json()
    ids = [item["id"] for item in listing["items"]]
    assert created["id"] in ids


def test_activate_restores_default_listing():
    created = client.post("/api/v1/products", json={
        "name": "Round Trip",
        "description": "x",
        "price": 1.0,
        "category": "Testing",
    }).json()

    client.patch(f"/api/v1/products/{created['id']}/deactivate")
    activate_response = client.patch(f"/api/v1/products/{created['id']}/activate")
    assert activate_response.status_code == 200
    assert activate_response.json()["active"] is True

    listing = client.get("/api/v1/products").json()
    ids = [item["id"] for item in listing["items"]]
    assert created["id"] in ids


def test_list_products_pagination():
    # Create 3 products.
    for i in range(3):
        client.post("/api/v1/products", json={
            "name": f"Item {i}",
            "description": "x",
            "price": 1.0,
            "category": "Testing",
        })

    # Ask for 2 — expect 2 items and a next_cursor.
    response = client.get("/api/v1/products?limit=2")
    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 2
    assert body["next_cursor"] is not None

    # Follow the cursor — expect the last 1 and no further cursor.
    response2 = client.get(f"/api/v1/products?limit=2&cursor={body['next_cursor']}")
    body2 = response2.json()
    assert len(body2["items"]) == 1
    assert body2["next_cursor"] is None