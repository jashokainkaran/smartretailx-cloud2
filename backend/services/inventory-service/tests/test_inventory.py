import os

# Point the app at a SEPARATE test table BEFORE importing it.
os.environ["INVENTORY_TABLE"] = "InventoryTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

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
    # A second, deliberately scarce product. The batch tests need two
    # products where one can satisfy a request and the other cannot —
    # that asymmetry is what proves all-or-nothing.
    table.put_item(Item={
        "product_id": "p2",
        "available_quantity": 5,
        "reserved_quantity": 0,
    })

    yield

    table.delete()
    table.wait_until_not_exists()


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


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


# ---------------------------------------------------------------------------
# Batch operations — the all-or-nothing reservation used by the Order saga.
#
# These exist because a multi-item order must never end up partially
# reserved: a basket where item 3 of 4 is out of stock would otherwise leave
# items 1 and 2 held, requiring the saga to compensate a state that should
# not be representable in the first place. TransactWriteItems removes it.
# ---------------------------------------------------------------------------


def _stock(product_id):
    """Read a product's stock straight through the API, for assertions."""
    return client.get(f"/api/v1/inventory/{product_id}").json()


def test_batch_reserve_reserves_every_product():
    response = client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    assert response.status_code == 200
    assert response.json()["products"] == 2

    assert _stock("p1") == {"product_id": "p1", "available_quantity": 90, "reserved_quantity": 10}
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 3, "reserved_quantity": 2}


def test_batch_reserve_is_all_or_nothing():
    """
    THE key test for the saga.

    p1 has plenty, p2 does not. The transaction must fail as a whole and
    leave BOTH products completely untouched — not just the one that was
    short. If p1 were reserved and p2 were not, the order would be
    partially reserved and the saga would need a compensation path for it.
    """
    response = client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},     # fine on its own
        {"product_id": "p2", "quantity": 999},    # impossible
    ])
    assert response.status_code == 409

    # p1 must be untouched, even though its own condition would have passed.
    assert _stock("p1") == {"product_id": "p1", "available_quantity": 100, "reserved_quantity": 0}
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 5, "reserved_quantity": 0}


def test_batch_reserve_names_the_product_that_failed():
    """
    CancellationReasons is positional, which is what lets the error name the
    offending product rather than saying "something failed". A customer-facing
    checkout needs to say WHICH item is unavailable.
    """
    response = client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 999},
    ])
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "p2" in detail
    assert "p1" not in detail       # p1 was fine; don't blame it


def test_batch_reserve_aggregates_duplicate_lines():
    """
    The same product on two basket lines is one DynamoDB operation, not two.

    Without aggregation this raises ValidationException, because DynamoDB
    forbids two operations on the same item inside one transaction. The
    quantities must also be summed: 4 + 3 must reserve 7, not 4 or 3.
    """
    response = client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 4},
        {"product_id": "p1", "quantity": 3},
    ])
    assert response.status_code == 200
    assert _stock("p1") == {"product_id": "p1", "available_quantity": 93, "reserved_quantity": 7}


def test_batch_reserve_aggregated_total_is_what_gets_checked():
    """
    Two lines that each fit but together do not must be rejected.

    p2 has 5 units. 3 + 3 = 6. Checking the lines individually would let
    this through and oversell by one; checking the aggregate rejects it.
    """
    response = client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p2", "quantity": 3},
        {"product_id": "p2", "quantity": 3},
    ])
    assert response.status_code == 409
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 5, "reserved_quantity": 0}


def test_batch_release_returns_everything_to_available():
    client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    response = client.post("/api/v1/inventory/release", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    assert response.status_code == 200

    assert _stock("p1") == {"product_id": "p1", "available_quantity": 100, "reserved_quantity": 0}
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 5, "reserved_quantity": 0}


def test_batch_release_is_all_or_nothing():
    """
    Compensation must be atomic too. If releasing p2 is invalid, p1 must not
    be released either — a half-completed compensation is worse than none,
    because the saga would believe it had undone the whole reservation.
    """
    client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    response = client.post("/api/v1/inventory/release", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 999},    # more than is reserved
    ])
    assert response.status_code == 409

    # Both still reserved, exactly as they were.
    assert _stock("p1") == {"product_id": "p1", "available_quantity": 90, "reserved_quantity": 10}
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 3, "reserved_quantity": 2}


def test_batch_confirm_clears_reserved_without_touching_available():
    client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    response = client.post("/api/v1/inventory/confirm", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    assert response.status_code == 200

    # available is unchanged from the reserve — those units already left it.
    assert _stock("p1") == {"product_id": "p1", "available_quantity": 90, "reserved_quantity": 0}
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 3, "reserved_quantity": 0}


def test_batch_confirm_is_all_or_nothing():
    client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 2},
    ])
    response = client.post("/api/v1/inventory/confirm", json=[
        {"product_id": "p1", "quantity": 10},
        {"product_id": "p2", "quantity": 999},
    ])
    assert response.status_code == 409

    assert _stock("p1") == {"product_id": "p1", "available_quantity": 90, "reserved_quantity": 10}
    assert _stock("p2") == {"product_id": "p2", "available_quantity": 3, "reserved_quantity": 2}


def test_batch_reserve_unknown_product_is_rejected():
    """
    A product with no inventory record fails the available_quantity
    condition, because a missing attribute cannot satisfy a comparison.
    The order is rejected and nothing else in the basket is touched.
    """
    response = client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 1},
        {"product_id": "does-not-exist", "quantity": 1},
    ])
    assert response.status_code == 409
    assert _stock("p1") == {"product_id": "p1", "available_quantity": 100, "reserved_quantity": 0}


def test_batch_reserve_empty_list_is_rejected():
    response = client.post("/api/v1/inventory/reserve", json=[])
    assert response.status_code == 400


def test_batch_reserve_zero_or_negative_quantity_is_rejected():
    """Rejected by the StockOperation model (gt=0), before any DynamoDB call."""
    assert client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": 0},
    ]).status_code == 422
    assert client.post("/api/v1/inventory/reserve", json=[
        {"product_id": "p1", "quantity": -5},
    ]).status_code == 422
