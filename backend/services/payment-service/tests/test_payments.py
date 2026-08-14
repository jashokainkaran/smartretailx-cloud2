import os

# Point the app at a SEPARATE test table BEFORE importing it.
os.environ["PAYMENTS_TABLE"] = "PaymentsTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"

import boto3
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config

client = TestClient(app)


@pytest.fixture(autouse=True)
def test_table():
    """Create a clean PaymentsTest table before each test, delete it after."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    table = dynamodb.create_table(
        TableName="PaymentsTest",
        KeySchema=[{"AttributeName": "payment_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "payment_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()

    yield

    table.delete()
    table.wait_until_not_exists()


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_charge_succeeds():
    response = client.post("/api/v1/payments", json={
        "order_id": "order-1",
        "amount": "25.00",
        "payment_token": "tok_test",
    })
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "SUCCEEDED"
    assert body["transaction_reference"] is not None


def test_charge_declined():
    response = client.post("/api/v1/payments", json={
        "order_id": "order-2",
        "amount": "25.00",
        "payment_token": "tok_test_decline",
    })
    assert response.status_code == 402
    body = response.json()
    assert body["status"] == "FAILED"
    assert body["transaction_reference"] is None
    assert body["failure_reason"]


def test_get_payment():
    created = client.post("/api/v1/payments", json={
        "order_id": "order-3",
        "amount": "10.00",
        "payment_token": "tok_test",
    }).json()

    response = client.get(f"/api/v1/payments/{created['payment_id']}")
    assert response.status_code == 200
    assert response.json()["payment_id"] == created["payment_id"]


def test_get_missing_payment_returns_404():
    response = client.get("/api/v1/payments/does-not-exist")
    assert response.status_code == 404


def test_refund_succeeded_payment():
    created = client.post("/api/v1/payments", json={
        "order_id": "order-4",
        "amount": "10.00",
        "payment_token": "tok_test",
    }).json()

    response = client.post(f"/api/v1/payments/{created['payment_id']}/refund")
    assert response.status_code == 200
    assert response.json()["status"] == "REFUNDED"


def test_refund_already_refunded():
    created = client.post("/api/v1/payments", json={
        "order_id": "order-5",
        "amount": "10.00",
        "payment_token": "tok_test",
    }).json()

    first = client.post(f"/api/v1/payments/{created['payment_id']}/refund")
    second = client.post(f"/api/v1/payments/{created['payment_id']}/refund")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["refunded_at"] == second.json()["refunded_at"]
    assert first.json()["already_refunded"] is False
    assert second.json()["already_refunded"] is True


def test_already_refunded_is_not_persisted():
    created = client.post("/api/v1/payments", json={
        "order_id": "order-8",
        "amount": "10.00",
        "payment_token": "tok_test",
    }).json()

    client.post(f"/api/v1/payments/{created['payment_id']}/refund")

    fetched = client.get(f"/api/v1/payments/{created['payment_id']}")
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "REFUNDED"
    assert fetched.json()["already_refunded"] is None


def test_refund_failed_payment_returns_409():
    created = client.post("/api/v1/payments", json={
        "order_id": "order-6",
        "amount": "10.00",
        "payment_token": "tok_test_decline",
    }).json()

    response = client.post(f"/api/v1/payments/{created['payment_id']}/refund")
    assert response.status_code == 409


def test_refund_missing_payment_returns_404():
    response = client.post("/api/v1/payments/does-not-exist/refund")
    assert response.status_code == 404
