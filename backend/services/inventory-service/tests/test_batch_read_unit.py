"""Batch-read checks that do not require a running DynamoDB Local process."""

import os

os.environ["INVENTORY_TABLE"] = "InventoryTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

from fastapi.testclient import TestClient

from app import config, repository
from app.main import app


class FakeDynamoDB:
    def __init__(self):
        self.calls = 0

    def batch_get_item(self, RequestItems):
        self.calls += 1
        if self.calls == 1:
            return {
                "Responses": {
                    config.INVENTORY_TABLE: [{
                        "product_id": "p2",
                        "available_quantity": 5,
                        "reserved_quantity": 0,
                    }],
                },
                "UnprocessedKeys": {
                    config.INVENTORY_TABLE: {"Keys": [{"product_id": "p1"}]},
                },
            }
        return {
            "Responses": {
                config.INVENTORY_TABLE: [{
                    "product_id": "p1",
                    "available_quantity": 10,
                    "reserved_quantity": 0,
                }],
            },
            "UnprocessedKeys": {},
        }


def test_repository_retries_unprocessed_keys_and_preserves_first_seen_order(monkeypatch):
    fake_dynamodb = FakeDynamoDB()
    monkeypatch.setattr(repository, "dynamodb", fake_dynamodb)

    result = repository.get_stock_batch(["p1", "p2", "p1"])

    assert [item["product_id"] for item in result] == ["p1", "p2"]
    assert fake_dynamodb.calls == 2


def test_batch_route_validates_input_and_returns_inventory(monkeypatch):
    monkeypatch.setattr(
        repository,
        "get_stock_batch",
        lambda product_ids: [{
            "product_id": product_ids[0],
            "available_quantity": 7,
            "reserved_quantity": 0,
        }],
    )
    client = TestClient(app)

    response = client.post(
        "/api/v1/inventory/admin/batch",
        json={"product_ids": ["p1"]},
    )

    assert response.status_code == 200
    assert response.json() == [{
        "product_id": "p1",
        "available_quantity": 7,
        "reserved_quantity": 0,
    }]
    assert client.post(
        "/api/v1/inventory/admin/batch", json={"product_ids": []}
    ).status_code == 422
    assert client.post(
        "/api/v1/inventory/admin/batch", json={"product_ids": [" "]}
    ).status_code == 422
