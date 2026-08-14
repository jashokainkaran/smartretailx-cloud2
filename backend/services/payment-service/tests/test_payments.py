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


class _RaisingProvider:
    """Stand-in provider used to simulate a PSP that never returns."""

    def charge(self, amount, payment_token, idempotency_key):
        raise RuntimeError("simulated PSP timeout")

    def refund(self, transaction_reference, idempotency_key):
        return True


def test_charge_provider_exception_returns_500_and_records_unknown(monkeypatch):
    monkeypatch.setattr("app.repository.get_provider", lambda: _RaisingProvider())

    # The default client re-raises server exceptions instead of turning
    # them into a response; this endpoint's 500 needs to be observable.
    local_client = TestClient(app, raise_server_exceptions=False)
    response = local_client.post("/api/v1/payments", json={
        "order_id": "order-9",
        "amount": "10.00",
        "payment_token": "tok_test",
    })
    assert response.status_code == 500

    from app import repository
    items = repository.table.scan()["Items"]
    matching = [i for i in items if i["order_id"] == "order-9"]
    assert len(matching) == 1
    assert matching[0]["status"] == "UNKNOWN"
    assert "simulated PSP timeout" in matching[0]["failure_reason"]


def test_refund_unknown_payment_returns_409(monkeypatch):
    monkeypatch.setattr("app.repository.get_provider", lambda: _RaisingProvider())

    local_client = TestClient(app, raise_server_exceptions=False)
    local_client.post("/api/v1/payments", json={
        "order_id": "order-10",
        "amount": "10.00",
        "payment_token": "tok_test",
    })

    from app import repository
    items = repository.table.scan()["Items"]
    payment_id = [i for i in items if i["order_id"] == "order-10"][0]["payment_id"]

    response = client.post(f"/api/v1/payments/{payment_id}/refund")
    assert response.status_code == 409


def test_charge_does_not_persist_already_refunded():
    created = client.post("/api/v1/payments", json={
        "order_id": "order-11",
        "amount": "10.00",
        "payment_token": "tok_test",
    }).json()

    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    raw_table = dynamodb.Table("PaymentsTest")
    item = raw_table.get_item(Key={"payment_id": created["payment_id"]})["Item"]

    assert "already_refunded" not in item


def test_refund_pending_payment_returns_409():
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    raw_table = dynamodb.Table("PaymentsTest")
    raw_table.put_item(Item={
        "payment_id": "pending-payment-1",
        "order_id": "order-12",
        "amount": "10.00",
        "status": "PENDING",
        "created_at": "2026-08-14T00:00:00+00:00",
    })

    response = client.post("/api/v1/payments/pending-payment-1/refund")
    assert response.status_code == 409


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
