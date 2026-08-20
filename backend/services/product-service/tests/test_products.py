import os

# Point the app at a SEPARATE test table BEFORE importing it.
# This must happen before "from app.main import app" so config picks it up.
os.environ["PRODUCTS_TABLE"] = "ProductsTest"
os.environ["OUTBOX_TABLE"] = "ProductOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

import boto3
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config, images

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
    assert response.json() == {"status": "healthy"}


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

    # The admin-only listing, not the public one: a deactivated product is
    # never returned by GET /api/v1/products (see that route's docstring).
    listing = client.get("/api/v1/products/admin").json()
    ids = [item["id"] for item in listing["items"]]
    assert created["id"] in ids


def test_public_listing_never_returns_deactivated_products():
    created = client.post("/api/v1/products", json={
        "name": "Withdrawn",
        "description": "x",
        "price": 1.0,
        "category": "Testing",
    }).json()

    client.patch(f"/api/v1/products/{created['id']}/deactivate")

    listing = client.get("/api/v1/products").json()
    ids = [item["id"] for item in listing["items"]]
    assert created["id"] not in ids


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

# ---------------------------------------------------------------------------
# Batch lookup — used by the Order saga to price a basket server-side.
# ---------------------------------------------------------------------------


def _create(name, price):
    return client.post("/api/v1/products", json={
        "name": name,
        "description": "Batch test",
        "price": price,
        "category": "Testing",
    }).json()


def test_batch_get_returns_requested_products():
    a = _create("Batch A", "10.00")
    b = _create("Batch B", "20.50")

    response = client.post("/api/v1/products/batch", json={
        "product_ids": [a["id"], b["id"]],
    })
    assert response.status_code == 200

    returned = {p["id"]: p for p in response.json()}
    assert set(returned) == {a["id"], b["id"]}
    assert returned[b["id"]]["price"] == "20.50"      # string, not a float (ADR-039)


def test_batch_get_omits_unknown_ids():
    """
    A missing product is absent from the response, not an error. The saga
    compares what it asked for with what came back and rejects the order —
    the catalogue does not decide what missing means.
    """
    a = _create("Batch A", "10.00")

    response = client.post("/api/v1/products/batch", json={
        "product_ids": [a["id"], "does-not-exist"],
    })
    assert response.status_code == 200

    returned = [p["id"] for p in response.json()]
    assert returned == [a["id"]]


def test_batch_get_deduplicates_ids():
    """
    DynamoDB raises ValidationException on duplicate keys in one
    BatchGetItem request. The same product on two basket lines is ordinary,
    so the ids are de-duplicated before the call and the product comes back
    exactly once.
    """
    a = _create("Batch A", "10.00")

    response = client.post("/api/v1/products/batch", json={
        "product_ids": [a["id"], a["id"], a["id"]],
    })
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_batch_get_includes_deactivated_products():
    """
    Deactivated products are returned with active: false rather than being
    filtered out (ADR-037). If they were omitted, the saga could not tell a
    withdrawn product from a non-existent one, and the customer would get
    the wrong message.
    """
    a = _create("Batch A", "10.00")
    client.patch(f"/api/v1/products/{a['id']}/deactivate")

    response = client.post("/api/v1/products/batch", json={
        "product_ids": [a["id"]],
    })
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["active"] is False


def test_batch_get_empty_list_is_rejected():
    response = client.post("/api/v1/products/batch", json={"product_ids": []})
    assert response.status_code == 422


def test_batch_get_over_100_ids_is_rejected():
    """BatchGetItem's hard limit, enforced at the boundary with a clear error."""
    response = client.post("/api/v1/products/batch", json={
        "product_ids": [f"id-{n}" for n in range(101)],
    })
    assert response.status_code == 422


# ---- Image upload URL ----

def test_image_upload_url_rejects_unsupported_content_type():
    """SVG especially: it can embed a <script>, a real stored-XSS vector."""
    response = client.post(
        "/api/v1/products/admin/image-upload-url",
        json={"content_type": "image/svg+xml"},
    )
    assert response.status_code == 422


def test_image_upload_url_returns_presigned_post_and_public_url(monkeypatch):
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BUCKET", "test-bucket")
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BASE_URL", "https://images.example.com")
    monkeypatch.setattr(
        images._s3_client,
        "generate_presigned_post",
        lambda **kwargs: {
            "url": "https://test-bucket.s3.amazonaws.com/",
            "fields": {"key": kwargs["Key"], "Content-Type": kwargs["Fields"]["Content-Type"]},
        },
    )

    response = client.post(
        "/api/v1/products/admin/image-upload-url",
        json={"content_type": "image/png"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["post_url"] == "https://test-bucket.s3.amazonaws.com/"
    assert body["fields"]["Content-Type"] == "image/png"
    assert body["image_url"].startswith(
        "https://images.example.com/product-images/products/"
    )
    assert body["image_url"].endswith(".png")


def test_image_upload_url_size_cap_is_signed_into_the_conditions(monkeypatch):
    """The 5MB cap must be enforced by S3 itself (via the signed
    content-length-range condition), not just the browser's own check —
    otherwise calling this endpoint directly bypasses it entirely."""
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BUCKET", "test-bucket")
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BASE_URL", "https://images.example.com")
    seen_conditions = []

    def fake_presign(**kwargs):
        seen_conditions.extend(kwargs["Conditions"])
        return {"url": "https://test-bucket.s3.amazonaws.com/", "fields": {}}

    monkeypatch.setattr(images._s3_client, "generate_presigned_post", fake_presign)

    client.post("/api/v1/products/admin/image-upload-url", json={"content_type": "image/jpeg"})

    assert ["content-length-range", 1, images.MAX_UPLOAD_BYTES] in seen_conditions


def test_image_upload_url_generates_a_fresh_key_each_call(monkeypatch):
    """Two uploads must never collide on the same object key."""
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BUCKET", "test-bucket")
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BASE_URL", "https://images.example.com")
    seen_keys = []

    def fake_presign(**kwargs):
        seen_keys.append(kwargs["Key"])
        return {"url": "https://test-bucket.s3.amazonaws.com/", "fields": {}}

    monkeypatch.setattr(images._s3_client, "generate_presigned_post", fake_presign)

    for _ in range(2):
        response = client.post(
            "/api/v1/products/admin/image-upload-url",
            json={"content_type": "image/jpeg"},
        )
        assert response.status_code == 200

    assert len(set(seen_keys)) == 2


# ---- Image cleanup on replace ----

def test_updating_image_deletes_the_previous_object(monkeypatch):
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BASE_URL", "https://images.example.com")
    deleted = []
    monkeypatch.setattr(
        images._s3_client, "delete_object",
        lambda **kwargs: deleted.append(kwargs["Key"]),
    )

    created = client.post("/api/v1/products", json={
        "name": "Old Image Product", "description": "d", "price": "9.99",
        "category": "misc",
        "image_url": "https://images.example.com/product-images/products/old.png",
    }).json()

    response = client.put(f"/api/v1/products/{created['id']}", json={
        "image_url": "https://images.example.com/product-images/products/new.png",
    })
    assert response.status_code == 200
    assert deleted == ["product-images/products/old.png"]


def test_updating_an_unrelated_field_does_not_touch_s3(monkeypatch):
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BASE_URL", "https://images.example.com")
    called = []
    monkeypatch.setattr(images._s3_client, "delete_object", lambda **kwargs: called.append(kwargs))

    created = client.post("/api/v1/products", json={
        "name": "P", "description": "d", "price": "9.99", "category": "misc",
        "image_url": "https://images.example.com/product-images/products/keep.png",
    }).json()

    client.put(f"/api/v1/products/{created['id']}", json={"name": "P Renamed"})
    assert called == []


def test_external_image_url_is_never_deleted(monkeypatch):
    """A URL predating uploads (pasted manually, before this feature
    existed) must not be treated as one of ours to clean up."""
    monkeypatch.setattr(config, "PRODUCT_IMAGES_BASE_URL", "https://images.example.com")
    called = []
    monkeypatch.setattr(images._s3_client, "delete_object", lambda **kwargs: called.append(kwargs))

    created = client.post("/api/v1/products", json={
        "name": "P", "description": "d", "price": "9.99", "category": "misc",
        "image_url": "https://cdn.example.com/some/external.jpg",
    }).json()

    client.put(f"/api/v1/products/{created['id']}", json={
        "image_url": "https://images.example.com/product-images/products/new.png",
    })
    assert called == []
