"""Integration security tests — the REAL claims-parsing/authorization path.

Every other test file in this project runs with AUTH_TEST_MODE on, which
makes claims_from_request() short-circuit to a hardcoded Python dict and
never touch its real code path at all. That is exactly why the systemic
cognito:groups bracket-parsing bug (see IMPLEMENTATION_RECORD.md, the
2026-08-17 "systemic RBAC bug" update) shipped undetected — no test had
ever exercised what a genuine API-Gateway-shaped Lambda event looks like.

These tests call the real Mangum handler directly with hand-built event
dicts (the same shape API Gateway's HTTP API sends) and flip AUTH_TEST_MODE
off per-test via monkeypatch, so claims_from_request runs its real branch.
config.AUTH_TEST_MODE is read fresh on every call (a plain module attribute
lookup, not captured into a closure at import time), so monkeypatch.setattr
on the already-imported module is enough — no import-order gymnastics
needed.
"""
import json
import os

os.environ["ORDERS_TABLE"] = "OrdersTest"
os.environ["ORDER_OUTBOX_TABLE"] = "OrderOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

from decimal import Decimal

import boto3
import pytest

from app import config, repository, states
from app.main import handler
from app.models import Order, OrderLineItem


def detail_of(response):
    """A bare status code doesn't prove WHICH check rejected the request —
    a refactor that broke require_admin but tripped some unrelated 403
    elsewhere would still pass a status-code-only assertion. Checking the
    detail message pins down the actual code path."""
    return json.loads(response["body"])["detail"]


@pytest.fixture(autouse=True)
def test_tables():
    """Same shape as test_orders.py's fixture — this file has its own
    ownership check on those tables since there is no conftest.py sharing
    one across files (see CP-047's own note on that gap)."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )

    orders = dynamodb.create_table(
        TableName="OrdersTest",
        KeySchema=[{"AttributeName": "order_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "order_id", "AttributeType": "S"},
            {"AttributeName": "customer_id", "AttributeType": "S"},
            {"AttributeName": "created_at", "AttributeType": "S"},
            {"AttributeName": "saga_status", "AttributeType": "S"},
            {"AttributeName": "order_bucket", "AttributeType": "S"},
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
            {
                "IndexName": "all-orders-index",
                "KeySchema": [
                    {"AttributeName": "order_bucket", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    orders.wait_until_exists()

    outbox = dynamodb.create_table(
        TableName="OrderOutboxTest",
        KeySchema=[{"AttributeName": "event_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "event_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    outbox.wait_until_exists()

    yield

    orders.delete()
    orders.wait_until_not_exists()
    outbox.delete()
    outbox.wait_until_not_exists()


def lambda_event(method, path, claims=None, body=None):
    """The same shape API Gateway's HTTP API actually sends Lambda — enough
    of a real payload for Mangum's own HTTPGateway.scope to build a valid
    ASGI scope from, not a TestClient-simulated request."""
    event = {
        "version": "2.0",
        "routeKey": f"{method} {path}",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {},
        "requestContext": {
            "accountId": "194680606132",
            "apiId": "test-api",
            "domainName": "test-api.execute-api.eu-west-1.amazonaws.com",
            "http": {
                "method": method,
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
                "userAgent": "pytest",
            },
            "requestId": "test-request-id",
            "routeKey": f"{method} {path}",
            "stage": "$default",
            "time": "01/Jan/2026:00:00:00 +0000",
            "timeEpoch": 1767225600000,
        },
        "isBase64Encoded": False,
    }
    if claims is not None:
        event["requestContext"]["authorizer"] = {"jwt": {"claims": claims}}
    if body is not None:
        event["headers"]["content-type"] = "application/json"
        event["body"] = json.dumps(body)
    return event


def seed_order(order_id="order-under-test", customer_id="cust-a"):
    order = Order(
        order_id=order_id,
        customer_id=customer_id,
        items=[OrderLineItem(product_id="p1", quantity=1, unit_price=Decimal("10.00"), name="Widget")],
        total=Decimal("10.00"),
        status=states.CONFIRMED,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )
    repository.create_order(order)
    return order


# ---------------------------------------------------------------------------
# Auth-bypass: no claims, malformed claims
# ---------------------------------------------------------------------------

def test_no_claims_at_all_is_rejected(monkeypatch):
    """No authorizer context on the event — the shape of a request that
    never had a valid token, or reached Lambda some other way."""
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    response = handler(lambda_event("GET", "/api/v1/orders"), {})
    assert response["statusCode"] == 401
    assert detail_of(response) == "Authentication is required"


def test_claims_present_but_no_sub_is_rejected(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    response = handler(
        lambda_event("GET", "/api/v1/orders", claims={"cognito:groups": "[customers]"}), {}
    )
    assert response["statusCode"] == 401
    assert detail_of(response) == "Authentication is required"


# ---------------------------------------------------------------------------
# Admin-role: the actual regression test for the systemic RBAC bug, through
# the real Mangum handler — not just groups() in isolation (test_auth.py).
# ---------------------------------------------------------------------------

def test_single_group_bracket_string_is_accepted_end_to_end(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-1", "cognito:groups": "[customers]"}
    response = handler(lambda_event("GET", "/api/v1/orders", claims=claims), {})
    assert response["statusCode"] == 200


def test_customer_on_admin_only_route_is_rejected(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-1", "cognito:groups": "[customers]"}
    response = handler(lambda_event("GET", "/api/v1/orders/stuck", claims=claims), {})
    assert response["statusCode"] == 403
    assert detail_of(response) == "Administrator access is required"


def test_admin_single_group_bracket_string_reaches_admin_route(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "admin-1", "cognito:groups": "[admin]"}
    response = handler(lambda_event("GET", "/api/v1/orders/stuck", claims=claims), {})
    assert response["statusCode"] == 200


# ---------------------------------------------------------------------------
# The two newest admin routes (added the same night as this test file) —
# deliberately not skipped just because they're new; that's exactly the
# blind spot that let the RBAC bug through in the first place.
# ---------------------------------------------------------------------------

def test_customer_on_admin_wide_order_listing_is_rejected(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-1", "cognito:groups": "[customers]"}
    response = handler(lambda_event("GET", "/api/v1/orders/admin", claims=claims), {})
    assert response["statusCode"] == 403
    assert detail_of(response) == "Administrator access is required"


def test_admin_can_list_orders_across_customers(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "admin-1", "cognito:groups": "[admin]"}
    response = handler(lambda_event("GET", "/api/v1/orders/admin", claims=claims), {})
    assert response["statusCode"] == 200


def test_customer_cannot_list_ready_to_ship_orders(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-1", "cognito:groups": "[customers]"}
    response = handler(
        lambda_event("GET", "/api/v1/orders/admin/ready-to-ship", claims=claims), {}
    )
    assert response["statusCode"] == 403
    assert detail_of(response) == "Administrator access is required"


def test_admin_can_list_ready_to_ship_orders(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "admin-1", "cognito:groups": "[admin]"}
    response = handler(
        lambda_event("GET", "/api/v1/orders/admin/ready-to-ship", claims=claims), {}
    )
    assert response["statusCode"] == 200


def test_customer_cannot_set_delivery_status(monkeypatch):
    seed_order(customer_id="cust-a")
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-a", "cognito:groups": "[customers]"}
    event = lambda_event(
        "PATCH", "/api/v1/orders/order-under-test/delivery-status",
        claims=claims, body={"delivery_status": "SHIPPED"},
    )
    response = handler(event, {})
    assert response["statusCode"] == 403
    assert detail_of(response) == "Administrator access is required"


def test_admin_can_set_delivery_status(monkeypatch):
    seed_order(customer_id="cust-a")
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "admin-1", "cognito:groups": "[admin]"}
    event = lambda_event(
        "PATCH", "/api/v1/orders/order-under-test/delivery-status",
        claims=claims, body={"delivery_status": "SHIPPED"},
    )
    response = handler(event, {})
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["delivery_status"] == "SHIPPED"


# ---------------------------------------------------------------------------
# IDOR / ownership — IDs are guessable UUIDs; the group check alone does not
# stop a customer from asking for someone else's order by ID.
# ---------------------------------------------------------------------------

def test_customer_cannot_read_another_customers_order(monkeypatch):
    seed_order(customer_id="cust-a")
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-b", "cognito:groups": "[customers]"}
    response = handler(lambda_event("GET", "/api/v1/orders/order-under-test", claims=claims), {})
    # 404, not 403 — deliberately does not confirm the order exists at all.
    assert response["statusCode"] == 404
    assert detail_of(response) == "Order not found"


def test_owner_can_read_their_own_order(monkeypatch):
    seed_order(customer_id="cust-a")
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-a", "cognito:groups": "[customers]"}
    response = handler(lambda_event("GET", "/api/v1/orders/order-under-test", claims=claims), {})
    assert response["statusCode"] == 200


def test_admin_can_read_any_customers_order(monkeypatch):
    seed_order(customer_id="cust-a")
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "admin-1", "cognito:groups": "[admin]"}
    response = handler(lambda_event("GET", "/api/v1/orders/order-under-test", claims=claims), {})
    assert response["statusCode"] == 200
