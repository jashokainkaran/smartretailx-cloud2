import os

# Point the app at SEPARATE test tables BEFORE importing it.
os.environ["ORDERS_TABLE"] = "OrdersTest"
os.environ["ORDER_OUTBOX_TABLE"] = "OrderOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

import json
from decimal import Decimal

import boto3
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config, clients, states
from app.clients import DownstreamRejected, DownstreamUnknown

client = TestClient(app)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def test_tables():
    """Create clean orders + outbox tables before each test, drop them after."""
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


CATALOGUE = {
    "p1": {"id": "p1", "name": "Widget", "price": "10.00", "active": True},
    "p2": {"id": "p2", "name": "Gadget", "price": "2.50", "active": True},
}


class Calls:
    """Records what the saga actually called, so tests can assert on it."""

    def __init__(self):
        self.reserved = 0
        self.released = 0
        self.confirmed = 0
        self.charged = 0
        self.refunded = 0


@pytest.fixture
def calls(monkeypatch):
    """
    Replace the HTTP clients with in-memory doubles.

    The saga is being tested here, not the network. Every downstream
    failure mode is injected by overriding one of these afterwards.
    """
    recorded = Calls()

    def fetch_products(product_ids):
        return {pid: CATALOGUE[pid] for pid in product_ids if pid in CATALOGUE}

    def reserve_stock(line_items):
        recorded.reserved += 1

    def release_stock(line_items):
        recorded.released += 1

    def confirm_stock(line_items):
        recorded.confirmed += 1

    def charge_payment(order_id, amount, payment_token):
        recorded.charged += 1
        return {"payment_id": "pay-123", "status": "SUCCEEDED", "order_id": order_id}

    def refund_payment(payment_id):
        recorded.refunded += 1
        return {"payment_id": payment_id, "status": "REFUNDED"}

    monkeypatch.setattr(clients, "fetch_products", fetch_products)
    monkeypatch.setattr(clients, "reserve_stock", reserve_stock)
    monkeypatch.setattr(clients, "release_stock", release_stock)
    monkeypatch.setattr(clients, "confirm_stock", confirm_stock)
    monkeypatch.setattr(clients, "charge_payment", charge_payment)
    monkeypatch.setattr(clients, "refund_payment", refund_payment)

    return recorded


def shipping_address(**overrides):
    address = {
        "recipient_name": "Test Customer",
        "street": "1 Test Street",
        "city": "Testville",
        "postal_code": "T3 5TT",
        "country": "United Kingdom",
    }
    address.update(overrides)
    return address


def basket(items=None, customer_id="cust-1", token="tok_test_ok", payment_method="card"):
    # `items is None` rather than `items or ...` — an empty list is a
    # deliberate test input, not a missing argument.
    if items is None:
        items = [{"product_id": "p1", "quantity": 2}]
    payload = {
        "customer_id": customer_id,
        "items": items,
        "shipping_address": shipping_address(),
        "contact_email": "customer@example.com",
        "contact_phone": "+44 7700 900000",
        "payment_method": payment_method,
    }
    if payment_method == "card":
        payload["payment_token"] = token
    return payload


def outbox_records():
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    return dynamodb.Table("OrderOutboxTest").scan().get("Items", [])


def raw_order(order_id):
    """Read the stored item directly, including attributes the API hides."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    return dynamodb.Table("OrdersTest").get_item(Key={"order_id": order_id}).get("Item")


# ---------------------------------------------------------------------------
# Basics
# ---------------------------------------------------------------------------

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------

def test_checkout_confirms_the_order(calls):
    response = client.post("/api/v1/orders", json=basket())
    assert response.status_code == 201

    body = response.json()
    assert body["status"] == states.CONFIRMED
    assert body["payment_id"] == "pay-123"
    assert body["failure_reason"] is None

    # Every step ran exactly once, and nothing was compensated.
    assert (calls.reserved, calls.charged, calls.confirmed) == (1, 1, 1)
    assert (calls.released, calls.refunded) == (0, 0)


def test_total_is_computed_server_side_from_catalogue_prices(calls):
    """
    2 x 10.00 + 3 x 2.50 = 27.50, taken from the catalogue.

    The client sends only product_id and quantity — there is nowhere in the
    request model to put a price, which is what makes tampering impossible
    rather than merely discouraged.
    """
    response = client.post("/api/v1/orders", json=basket(items=[
        {"product_id": "p1", "quantity": 2},
        {"product_id": "p2", "quantity": 3},
    ]))
    assert response.status_code == 201

    body = response.json()
    assert body["total"] == "27.50"          # string, not a float (ADR-039)
    assert body["items"][0]["unit_price"] == "10.00"
    assert body["items"][0]["name"] == "Widget"


def test_client_supplied_price_is_ignored(calls):
    """A price in the request body must not reach the order."""
    payload = basket()
    payload["items"][0]["unit_price"] = "0.01"

    response = client.post("/api/v1/orders", json=payload)
    assert response.status_code == 201
    assert response.json()["total"] == "20.00"     # 2 x 10.00, not 2 x 0.01


def test_confirmed_order_publishes_an_outbox_event(calls):
    """
    The terminal state and its event are written in ONE transaction, so an
    order cannot reach CONFIRMED without owing an OrderConfirmed event.
    """
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    records = outbox_records()
    assert len(records) == 1
    assert records[0]["event_type"] == "OrderConfirmed"
    assert records[0]["event_source"] == "smartretailx.orders"
    assert records[0]["status"] == "PENDING"      # the relay clears this

    envelope = json.loads(records[0]["payload"])
    assert envelope["event_version"] == "1.0"
    assert envelope["event_id"] == records[0]["event_id"]
    assert envelope["data"]["order_id"] == order_id
    assert envelope["data"]["total"] == "20.00"


def test_confirmed_order_leaves_the_recovery_index(calls):
    """
    saga_status is REMOVEd on a healthy terminal state, so the order drops
    out of the sparse GSI entirely. That is what makes the stuck-order
    query cheap and meaningful.
    """
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    assert "saga_status" not in raw_order(order_id)
    assert client.get("/api/v1/orders/stuck").json() == []


# ---------------------------------------------------------------------------
# Step 1 failures — reserving stock
# ---------------------------------------------------------------------------

def test_insufficient_stock_rejects_without_charging(calls, monkeypatch):
    def reserve(line_items):
        raise DownstreamRejected(409, "Insufficient stock for: p1")

    monkeypatch.setattr(clients, "reserve_stock", reserve)

    response = client.post("/api/v1/orders", json=basket())
    assert response.status_code == 201        # the order exists; it failed

    body = response.json()
    assert body["status"] == states.REJECTED
    assert "p1" in body["failure_reason"]

    # The card was never touched, and there was nothing to release —
    # the reserve transaction is all-or-nothing.
    assert calls.charged == 0
    assert calls.released == 0


def test_rejected_order_publishes_order_failed(calls, monkeypatch):
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))

    client.post("/api/v1/orders", json=basket())

    records = outbox_records()
    assert len(records) == 1
    assert records[0]["event_type"] == "OrderFailed"


def test_reserve_timeout_records_stock_unknown(calls, monkeypatch):
    """
    No answer from Inventory. The stock may or may not be held, and we
    cannot find out (ADR-040). Guessing either way causes damage, so the
    uncertainty is recorded instead.
    """
    def reserve(line_items):
        raise DownstreamUnknown("no response from inventory: timeout")

    monkeypatch.setattr(clients, "reserve_stock", reserve)

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.STOCK_UNKNOWN

    # Critically: no release was attempted. Releasing stock that was never
    # reserved would invent inventory and reintroduce overselling.
    assert calls.released == 0
    assert calls.charged == 0

    # No event — nothing downstream should act on an undetermined outcome.
    assert outbox_records() == []


# ---------------------------------------------------------------------------
# Step 2 failures — taking payment
# ---------------------------------------------------------------------------

def test_declined_payment_releases_stock_and_fails(calls, monkeypatch):
    """
    The real Payment service's 402 body is the full Payment record, not a
    {"detail": ...} envelope (clients.charge_payment's own docstring), so
    exc.detail falls back to the raw response text rather than a clean
    message. The mock's `detail` argument is deliberately the raw-JSON-shaped
    value that fallback would actually produce, distinct from
    failure_reason in `body` — this is what catches a saga that reads the
    wrong field, which is exactly the bug this test previously missed by
    using a body that happened not to include failure_reason at all.
    """
    def charge(order_id, amount, payment_token):
        raise DownstreamRejected(
            402,
            '{"payment_id": "pay-declined", "status": "FAILED", "failure_reason": "Card declined by issuer"}',
            {
                "payment_id": "pay-declined",
                "status": "FAILED",
                "failure_reason": "Card declined by issuer",
            },
        )

    monkeypatch.setattr(clients, "charge_payment", charge)

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.FAILED
    assert body["failure_reason"] == "Card declined by issuer"
    assert "payment_id" not in body["failure_reason"]  # not the raw JSON blob

    # A 402 is a definite answer, so compensation is safe and required.
    assert calls.released == 1
    assert calls.refunded == 0

    # payment_id is recorded even though nothing was charged: it means "a
    # charge was attempted", not "a charge succeeded".
    assert body["payment_id"] == "pay-declined"


def test_failed_compensation_is_a_visible_terminal_state(calls, monkeypatch):
    """
    The card declined AND the stock release failed. Stock is now stranded
    in `reserved` where nobody can buy it. ADR-035: surface it loudly
    rather than retrying silently and burying it in a log line.
    """
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    monkeypatch.setattr(clients, "release_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory unreachable")
    ))

    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]
    body = client.get(f"/api/v1/orders/{order_id}").json()

    assert body["status"] == states.COMPENSATION_FAILED
    assert "release failed" in body["failure_reason"]

    # Stays in the recovery index — this one needs a human.
    assert raw_order(order_id)["saga_status"] == states.COMPENSATION_FAILED
    assert [o["order_id"] for o in client.get("/api/v1/orders/stuck").json()] == [order_id]

    # No OrderFailed event: a discrepancy nobody has resolved is not a
    # clean business outcome to broadcast.
    assert outbox_records() == []


def test_unknown_payment_does_not_release_or_refund(calls, monkeypatch):
    """
    ADR-034. The provider gave no answer, so the card may have been
    charged. Releasing the stock would take goods from a customer who may
    have paid; refunding would return money that may never have moved.
    Both are errors, so the saga does neither.
    """
    def charge(order_id, amount, payment_token):
        raise DownstreamUnknown("payment service returned 500")

    monkeypatch.setattr(clients, "charge_payment", charge)

    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]
    body = client.get(f"/api/v1/orders/{order_id}").json()

    assert body["status"] == states.PAYMENT_UNKNOWN
    assert calls.released == 0
    assert calls.refunded == 0

    assert raw_order(order_id)["saga_status"] == states.PAYMENT_UNKNOWN
    assert outbox_records() == []


def test_unknown_payment_is_distinct_from_declined(calls, monkeypatch):
    """
    The whole point of ADR-034 in one assertion: the same step failing two
    different ways produces two different terminal states and two different
    compensation decisions.
    """
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    declined = client.post("/api/v1/orders", json=basket()).json()

    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamUnknown("timeout")
    ))
    unknown = client.post("/api/v1/orders", json=basket()).json()

    assert declined["status"] == states.FAILED            # compensated
    assert unknown["status"] == states.PAYMENT_UNKNOWN     # NOT compensated
    assert calls.released == 1                            # once, for the decline only


# ---------------------------------------------------------------------------
# Step 3 failures — confirming the reservation
# ---------------------------------------------------------------------------

def test_confirm_failure_refunds_the_payment(calls, monkeypatch):
    def confirm(line_items):
        raise DownstreamRejected(409, "Cannot confirm more than is reserved for: p1")

    monkeypatch.setattr(clients, "confirm_stock", confirm)

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.FAILED
    assert calls.refunded == 1
    assert calls.released == 0      # confirm failed, so the hold still stands


def test_confirm_failure_with_failed_refund_is_compensation_failed(calls, monkeypatch):
    """
    The worst outcome in the system: the customer has been charged and will
    not receive goods.
    """
    monkeypatch.setattr(clients, "confirm_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "cannot confirm")
    ))
    monkeypatch.setattr(clients, "refund_payment", lambda pid: (_ for _ in ()).throw(
        DownstreamUnknown("payment service unreachable")
    ))

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.COMPENSATION_FAILED
    assert "refund failed" in body["failure_reason"]
    assert body["payment_id"] == "pay-123"


def test_confirm_timeout_records_stock_unknown_with_payment(calls, monkeypatch):
    """
    Money HAS moved here, unlike the reserve-timeout case. The payment id
    is retained so a human can see the customer paid while reconciling.
    """
    monkeypatch.setattr(clients, "confirm_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory timeout")
    ))

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.STOCK_UNKNOWN
    assert body["payment_id"] == "pay-123"
    assert calls.refunded == 0      # never refund an unobserved outcome


# ---------------------------------------------------------------------------
# Baskets that never become orders
# ---------------------------------------------------------------------------

def test_unknown_product_is_rejected_without_creating_an_order(calls):
    response = client.post("/api/v1/orders", json=basket(items=[
        {"product_id": "does-not-exist", "quantity": 1},
    ]))
    assert response.status_code == 409
    assert "Unknown product" in response.json()["detail"]
    assert calls.reserved == 0


def test_deactivated_product_is_rejected_with_its_own_message(calls, monkeypatch):
    """
    A withdrawn product and a non-existent one are different situations and
    the customer is told which — which is why the batch endpoint returns
    deactivated products rather than filtering them out (ADR-037).
    """
    monkeypatch.setattr(clients, "fetch_products", lambda ids: {
        "p1": {"id": "p1", "name": "Widget", "price": "10.00", "active": False},
    })

    response = client.post("/api/v1/orders", json=basket())
    assert response.status_code == 409
    assert "no longer for sale" in response.json()["detail"]


def test_catalogue_unavailable_returns_503(calls, monkeypatch):
    """
    Pricing failed, so nothing was written and nothing was attempted. The
    client can safely retry the entire request — which is exactly what 503
    means and 500 does not.
    """
    monkeypatch.setattr(clients, "fetch_products", lambda ids: (_ for _ in ()).throw(
        DownstreamUnknown("product service unreachable")
    ))

    response = client.post("/api/v1/orders", json=basket())
    assert response.status_code == 503


def test_empty_basket_is_rejected(calls):
    response = client.post("/api/v1/orders", json=basket(items=[]))
    assert response.status_code == 422
    assert calls.reserved == 0


def test_zero_quantity_is_rejected(calls):
    response = client.post("/api/v1/orders", json=basket(items=[
        {"product_id": "p1", "quantity": 0},
    ]))
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Concurrency and reads
# ---------------------------------------------------------------------------

def test_state_transition_requires_the_expected_current_state(calls):
    """
    The conditional write that makes the saga safe against duplicate runs.

    A second attempt to advance an order out of a state it has already left
    must fail rather than re-running the step — otherwise two concurrent
    invocations would both reserve and both charge.
    """
    from app import repository

    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    # The order is CONFIRMED. Pretending it is still TAKING_PAYMENT must
    # be refused.
    with pytest.raises(ValueError) as exc:
        repository.set_status(order_id, states.TAKING_PAYMENT, states.CONFIRMED)

    assert "expected TAKING_PAYMENT" in str(exc.value)
    assert client.get(f"/api/v1/orders/{order_id}").json()["status"] == states.CONFIRMED


def test_get_missing_order_returns_404(calls):
    assert client.get("/api/v1/orders/nope").status_code == 404


def test_list_orders_by_customer_is_newest_first(calls):
    first = client.post("/api/v1/orders", json=basket(customer_id="c9")).json()
    second = client.post("/api/v1/orders", json=basket(customer_id="c9")).json()
    client.post("/api/v1/orders", json=basket(customer_id="other"))

    body = client.get("/api/v1/orders?customer_id=c9").json()
    returned = [o["order_id"] for o in body["items"]]

    assert len(returned) == 2
    assert returned[0] == second["order_id"]      # newest first
    assert first["order_id"] in returned


def test_list_orders_paginates(calls):
    for _ in range(3):
        client.post("/api/v1/orders", json=basket(customer_id="c-page"))

    page1 = client.get("/api/v1/orders?customer_id=c-page&limit=2").json()
    assert len(page1["items"]) == 2
    assert page1["next_cursor"] is not None

    page2 = client.get(
        f"/api/v1/orders?customer_id=c-page&limit=2&cursor={page1['next_cursor']}"
    ).json()
    assert len(page2["items"]) == 1
    assert page2["next_cursor"] is None


# ---------------------------------------------------------------------------
# Cash on delivery
# ---------------------------------------------------------------------------

def test_cash_on_delivery_confirms_without_charging(calls):
    response = client.post("/api/v1/orders", json=basket(payment_method="cash_on_delivery"))
    assert response.status_code == 201

    body = response.json()
    assert body["status"] == states.PENDING_ON_DELIVERY
    assert body["payment_id"] is None
    assert body["payment_method"] == "cash_on_delivery"

    # Stock is still reserved and confirmed exactly like a card order —
    # only the payment step is skipped.
    assert (calls.reserved, calls.confirmed) == (1, 1)
    assert calls.charged == 0


def test_cash_on_delivery_publishes_order_confirmed_with_its_own_status(calls):
    order_id = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()["order_id"]

    records = outbox_records()
    assert len(records) == 1
    assert records[0]["event_type"] == "OrderConfirmed"

    envelope = json.loads(records[0]["payload"])
    assert envelope["data"]["order_id"] == order_id
    assert envelope["data"]["status"] == states.PENDING_ON_DELIVERY


def test_cash_on_delivery_leaves_the_recovery_index(calls):
    """PENDING_ON_DELIVERY is healthy-terminal, same as CONFIRMED — an order
    correctly awaiting delivery must not look like a stuck saga to an admin."""
    order_id = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()["order_id"]

    assert "saga_status" not in raw_order(order_id)
    assert client.get("/api/v1/orders/stuck").json() == []


def test_cash_on_delivery_insufficient_stock_still_rejects(calls, monkeypatch):
    """The reserve step is shared by both payment methods — COD does not
    bypass oversell prevention."""
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))

    body = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()
    assert body["status"] == states.REJECTED
    assert calls.confirmed == 0


def test_cash_on_delivery_confirm_failure_fails_with_nothing_to_compensate(calls, monkeypatch):
    """Nothing was ever charged, so unlike the card path there is no refund
    to attempt — the order goes straight to FAILED."""
    monkeypatch.setattr(clients, "confirm_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Cannot confirm more than is reserved for: p1")
    ))

    body = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()
    assert body["status"] == states.FAILED
    assert body["payment_id"] is None
    assert calls.refunded == 0
    assert calls.released == 0


def test_cash_on_delivery_confirm_timeout_records_stock_unknown(calls, monkeypatch):
    monkeypatch.setattr(clients, "confirm_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory timeout")
    ))

    body = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()
    assert body["status"] == states.STOCK_UNKNOWN
    assert body["payment_id"] is None


def test_card_payment_without_token_is_rejected(calls):
    payload = basket()
    del payload["payment_token"]

    response = client.post("/api/v1/orders", json=payload)
    assert response.status_code == 422


def test_cash_on_delivery_does_not_require_a_payment_token(calls):
    """basket(payment_method="cash_on_delivery") already omits payment_token
    entirely (see the helper above) — this asserts that is actually valid,
    not just untested."""
    response = client.post("/api/v1/orders", json=basket(payment_method="cash_on_delivery"))
    assert response.status_code == 201


def test_invalid_contact_email_is_rejected(calls):
    payload = basket()
    payload["contact_email"] = "not-an-email"

    response = client.post("/api/v1/orders", json=payload)
    assert response.status_code == 422


def test_stuck_orders_lists_every_needs_attention_state(calls, monkeypatch):
    """One query per status, because a GSI hash key only supports equality."""
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamUnknown("timeout")
    ))
    unknown_payment = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("timeout")
    ))
    unknown_stock = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    stuck = {o["order_id"]: o["status"] for o in client.get("/api/v1/orders/stuck").json()}

    assert stuck == {
        unknown_payment: states.PAYMENT_UNKNOWN,
        unknown_stock: states.STOCK_UNKNOWN,
    }


def test_delivery_status_can_be_set_on_a_confirmed_order(calls):
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    response = client.patch(
        f"/api/v1/orders/{order_id}/delivery-status",
        json={"delivery_status": "SHIPPED"},
    )
    assert response.status_code == 200
    assert response.json()["delivery_status"] == "SHIPPED"


def test_delivery_status_can_be_set_on_a_cash_on_delivery_order(calls):
    order_id = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()["order_id"]

    response = client.patch(
        f"/api/v1/orders/{order_id}/delivery-status",
        json={"delivery_status": "OUT_FOR_DELIVERY"},
    )
    assert response.status_code == 200
    assert response.json()["delivery_status"] == "OUT_FOR_DELIVERY"


def test_delivery_status_rejected_on_a_non_confirmed_order(calls, monkeypatch):
    """A REJECTED order has nothing to ship — the conditional guard in
    repository.set_delivery_status must refuse it, not just the frontend."""
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    response = client.patch(
        f"/api/v1/orders/{order_id}/delivery-status",
        json={"delivery_status": "SHIPPED"},
    )
    assert response.status_code == 409


def test_delivery_status_on_missing_order_is_404(calls):
    response = client.patch(
        "/api/v1/orders/does-not-exist/delivery-status",
        json={"delivery_status": "SHIPPED"},
    )
    assert response.status_code == 404


def test_delivery_status_rejects_an_unknown_value(calls):
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    response = client.patch(
        f"/api/v1/orders/{order_id}/delivery-status",
        json={"delivery_status": "TELEPORTED"},
    )
    assert response.status_code == 422


def test_admin_order_list_spans_every_customer(calls):
    """The customer-scoped GET /api/v1/orders cannot see across customers —
    this is the deliberately separate, admin-gated capability that can."""
    first = client.post("/api/v1/orders", json=basket(customer_id="cust-a")).json()["order_id"]
    second = client.post("/api/v1/orders", json=basket(customer_id="cust-b")).json()["order_id"]

    seen = {o["order_id"] for o in client.get("/api/v1/orders/admin").json()["items"]}
    assert {first, second} <= seen
