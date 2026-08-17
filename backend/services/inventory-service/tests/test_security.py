"""Integration security tests — the REAL claims-parsing/authorization path.

See order-service/tests/test_security.py for the full rationale: every other
test file runs with AUTH_TEST_MODE on, which bypasses claims_from_request
entirely and is why the systemic cognito:groups bracket-parsing bug shipped
undetected. These call the real Mangum handler directly with a hand-built
API-Gateway-shaped event and AUTH_TEST_MODE genuinely off.
"""
import json
import os

os.environ["INVENTORY_TABLE"] = "InventoryTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

import boto3
import pytest

from app import config
from app.main import handler


def detail_of(response):
    """A bare status code doesn't prove WHICH check rejected the request —
    checking the detail message pins down the actual code path."""
    return json.loads(response["body"])["detail"]


@pytest.fixture(autouse=True)
def test_table():
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
    yield
    table.delete()
    table.wait_until_not_exists()


def lambda_event(method, path, claims=None, query=""):
    event = {
        "version": "2.0",
        "routeKey": f"{method} {path}",
        "rawPath": path,
        "rawQueryString": query,
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
    return event


def test_no_claims_at_all_is_rejected(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    response = handler(lambda_event("POST", "/api/v1/inventory/p1/add", query="quantity=5"), {})
    assert response["statusCode"] == 401
    assert detail_of(response) == "Authentication is required"


def test_customer_on_admin_only_route_is_rejected(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "cust-1", "cognito:groups": "[customers]"}
    response = handler(
        lambda_event("POST", "/api/v1/inventory/p1/add", claims=claims, query="quantity=5"), {}
    )
    assert response["statusCode"] == 403
    assert detail_of(response) == "Administrator access is required"


def test_admin_single_group_bracket_string_is_accepted_end_to_end(monkeypatch):
    """The actual regression test for the systemic RBAC bug — through the
    real Mangum handler, not just groups() in isolation (test_auth.py)."""
    monkeypatch.setattr(config, "AUTH_TEST_MODE", False)
    claims = {"sub": "admin-1", "cognito:groups": "[admin]"}
    response = handler(
        lambda_event("POST", "/api/v1/inventory/p1/add", claims=claims, query="quantity=5"), {}
    )
    assert response["statusCode"] == 200
