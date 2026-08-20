import os

# Point the app at SEPARATE test tables BEFORE importing it.
os.environ["ORDERS_TABLE"] = "OrdersTest"
os.environ["ORDER_OUTBOX_TABLE"] = "OrderOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

import json
import time

import boto3
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import circuit_breaker, config, clients, states
from app.circuit_breaker import CircuitOpenError
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


@pytest.fixture(autouse=True)
def clean_circuit_breakers():
    """
    Circuit breaker state lives in module-level memory (app/circuit_breaker.py),
    shared across every test in this process — without this, a test that
    trips a breaker (e.g. by raising DownstreamUnknown from a mocked client)
    would leave it OPEN for whatever test happens to run next, regardless of
    whether that test has anything to do with circuit breaking. Autouse so
    every test in this file gets a clean CLOSED breaker, not just the ones
    that know to ask for it.
    """
    circuit_breaker.reset_all()
    yield
    circuit_breaker.reset_all()


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
    # A browser now sends the price it showed the customer. The order service
    # compares it with the authoritative catalogue price before any side
    # effect. Keep older test bodies concise while making every normal basket
    # represent the current displayed catalogue state.
    items = [
        {
            **item,
            "expected_unit_price": item.get(
                "expected_unit_price", CATALOGUE.get(item["product_id"], {"price": "0.01"})["price"]
            ),
        }
        for item in items
    ]
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
    assert response.json() == {"status": "healthy"}


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


def test_price_change_stops_checkout_before_any_order_or_side_effect(calls, monkeypatch):
    """A changed catalogue price requires explicit customer acknowledgement."""
    updated_catalogue = {**CATALOGUE, "p1": {**CATALOGUE["p1"], "price": "12.00"}}
    monkeypatch.setattr(
        clients,
        "fetch_products",
        lambda product_ids: {pid: updated_catalogue[pid] for pid in product_ids if pid in updated_catalogue},
    )

    response = client.post("/api/v1/orders", json=basket())

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "PRICE_CHANGED"
    assert detail["changes"] == [{
        "product_id": "p1",
        "name": "Widget",
        "expected_unit_price": "10.00",
        "current_unit_price": "12.00",
    }]
    assert (calls.reserved, calls.charged, calls.confirmed) == (0, 0, 0)
    assert outbox_records() == []


def test_checkout_requires_the_price_customer_saw(calls):
    payload = basket()
    del payload["items"][0]["expected_unit_price"]

    response = client.post("/api/v1/orders", json=payload)

    assert response.status_code == 422
    assert calls.reserved == 0


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


def test_published_event_carries_enough_to_send_a_receipt_with_no_callback(calls):
    """
    The Notification service (ADR-006) is designed to send a receipt from
    the event alone, without calling back to Order or the Product Catalogue
    for anything. That only holds if the event actually carries a
    contact_email and full line-item detail — not just an order_id and a
    total. This is the regression test for that contract.
    """
    client.post("/api/v1/orders", json=basket())

    envelope = json.loads(outbox_records()[0]["payload"])
    data = envelope["data"]
    assert data["contact_email"] == "customer@example.com"
    assert data["recipient_name"] == "Test Customer"
    assert data["items"] == [
        {"product_id": "p1", "quantity": 2, "unit_price": "10.00", "name": "Widget"}
    ]
    # The Notification service logs this alongside its own — without it in
    # the event itself (not just Order's own log lines), there is no way to
    # trace one customer's request across both services' logs.
    assert "correlation_id" in data


def test_rejected_order_event_also_carries_contact_email_and_items(calls, monkeypatch):
    """The receipt contract applies to OrderFailed too, not just the happy
    path — a declined or rejected order still owes the customer an email."""
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))

    response = client.post("/api/v1/orders", json=basket())
    order_id = response.json()["order_id"]

    envelope = json.loads(outbox_records()[0]["payload"])
    data = envelope["data"]
    assert data["order_id"] == order_id
    assert data["contact_email"] == "customer@example.com"
    assert data["recipient_name"] == "Test Customer"
    assert data["items"] == [
        {"product_id": "p1", "quantity": 2, "unit_price": "10.00", "name": "Widget"}
    ]
    assert "correlation_id" in data


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
# Circuit breaker: forward-path handling when a breaker is already open
# ---------------------------------------------------------------------------
# Breaker-internals tests (trip/reset/half-open) live in
# test_circuit_breaker.py. These are saga-integration tests proving the
# corrected exception handling: a skipped call is a CERTAIN outcome (nothing
# was sent, so nothing could have happened), not an uncertain one, and must
# not be routed into the same STOCK_UNKNOWN/PAYMENT_UNKNOWN branches as a
# genuine DownstreamUnknown — that was the bug an earlier version of
# CircuitOpenError had, by being a DownstreamUnknown subclass.

def _trip_breaker(service: str):
    breaker = circuit_breaker._breaker_for(service)
    breaker.state = "OPEN"
    breaker.opened_at = time.monotonic()


def test_open_inventory_breaker_before_reserve_rejects_cleanly_not_as_unknown(calls):
    """
    The breaker skips reserve_stock entirely — nothing was reserved, the
    same certain outcome as a definite 409. Must become REJECTED, not
    STOCK_UNKNOWN: there is nothing uncertain here to reconcile.
    """
    _trip_breaker("inventory")

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.REJECTED
    assert "inventory service temporarily unavailable" in body["failure_reason"]

    # The underlying client function was never invoked at all.
    assert calls.reserved == 0
    assert calls.released == 0
    assert calls.charged == 0


def test_open_payment_breaker_before_charge_releases_stock_not_payment_unknown(calls):
    """
    Stock WAS reserved in step 1. The breaker then skips charge_payment
    entirely — certain that nothing was charged — so the correct action is
    to release the reservation and fail cleanly, exactly like a card
    decline. Must NOT leave the order as PAYMENT_UNKNOWN with stock
    stranded in `reserved` for no reason: there is no uncertainty to guard
    against here.
    """
    _trip_breaker("payment")

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.FAILED
    assert "payment service temporarily unavailable" in body["failure_reason"]
    assert body["payment_id"] is None  # no attempt was made, so no id exists

    assert calls.reserved == 1
    assert calls.charged == 0
    assert calls.released == 1  # the stock reserved in step 1 IS released


def test_open_inventory_breaker_before_confirm_refunds_not_stock_unknown(calls, monkeypatch):
    """
    Payment WAS taken in step 2. The inventory breaker is open specifically
    for confirm_stock (step 3), not reserve_stock (step 1) — both go
    through the same "inventory" breaker, so simply pre-tripping it would
    make step 1 fail too, and setting it via a side effect inside
    reserve_stock does not survive either: guarded()'s own on_success()
    closes it again right after reserve_stock returns normally, since it
    is the same breaker object. Instead, guarded() itself is wrapped so
    only the SECOND "inventory" call (confirm, not reserve) sees it open —
    a call-count fake, not the real trip mechanism, because what is under
    test here is saga.py's exception handling, not the breaker's own state
    machine (that is test_circuit_breaker.py's job).

    Certain that nothing was confirmed, so the correct action is to refund
    the payment taken in step 2 and fail — not leave the order as
    STOCK_UNKNOWN with money taken and no resolution in sight.
    """
    real_guarded = circuit_breaker.guarded
    inventory_calls = {"count": 0}

    def guarded_confirm_open(service, fn, *args, **kwargs):
        if service == "inventory":
            inventory_calls["count"] += 1
            if inventory_calls["count"] == 2:  # 1st = reserve, 2nd = confirm
                raise CircuitOpenError("circuit open for inventory, call skipped")
        return real_guarded(service, fn, *args, **kwargs)

    monkeypatch.setattr(circuit_breaker, "guarded", guarded_confirm_open)

    body = client.post("/api/v1/orders", json=basket()).json()
    assert body["status"] == states.FAILED
    assert "inventory service temporarily unavailable" in body["failure_reason"]

    assert calls.reserved == 1
    assert calls.charged == 1
    assert calls.confirmed == 0  # confirm_stock itself was never invoked
    assert calls.refunded == 1   # the payment taken in step 2 IS refunded


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
    detail = response.json()["detail"]
    assert "Unknown product" in detail
    # The raw internal id must never reach the customer — no name exists to
    # show instead here, so the message stays generic rather than leaking it.
    assert "does-not-exist" not in detail
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
    detail = response.json()["detail"]
    assert "no longer for sale" in detail
    # The product's name is shown, not its raw internal id.
    assert "Widget" in detail
    assert "p1" not in detail


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


def test_ready_to_ship_lists_only_confirmed_orders_without_delivery_status(calls):
    card_order = client.post("/api/v1/orders", json=basket()).json()["order_id"]
    cod_order = client.post(
        "/api/v1/orders", json=basket(payment_method="cash_on_delivery")
    ).json()["order_id"]
    client.patch(
        f"/api/v1/orders/{card_order}/delivery-status",
        json={"delivery_status": "PROCESSING"},
    )

    response = client.get("/api/v1/orders/admin/ready-to-ship?limit=5")

    assert response.status_code == 200
    assert [order["order_id"] for order in response.json()] == [cod_order]
    assert response.json()[0]["status"] == states.PENDING_ON_DELIVERY
    assert response.json()[0]["delivery_status"] is None


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


# ---------------------------------------------------------------------------
# DeliveryStatusChanged publishing (CP-020's delivery-tracking follow-up) —
# best-effort, feeds Notification's email extension, not a WebSocket push
# (the customer is almost never present when this happens)
# ---------------------------------------------------------------------------

def test_delivery_status_change_publishes_an_event(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    published = []
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: published.append(kwargs) or {},
    )
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    client.patch(f"/api/v1/orders/{order_id}/delivery-status", json={"delivery_status": "SHIPPED"})

    assert len(published) == 1
    entry = published[0]["Entries"][0]
    assert entry["Source"] == "smartretailx.orders"
    assert entry["DetailType"] == "DeliveryStatusChanged"
    detail = json.loads(entry["Detail"])
    assert "event_id" in detail  # Notification's idempotency check needs one
    data = detail["data"]
    assert data["order_id"] == order_id
    assert data["delivery_status"] == "SHIPPED"
    assert data["contact_email"] == "customer@example.com"
    assert "correlation_id" in data


def test_a_delivery_status_publish_failure_does_not_fail_the_response(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("EventBridge is unreachable")),
    )
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    response = client.patch(f"/api/v1/orders/{order_id}/delivery-status", json={"delivery_status": "SHIPPED"})

    assert response.status_code == 200
    assert response.json()["delivery_status"] == "SHIPPED"


def test_a_rejected_delivery_status_entry_is_treated_as_a_failure(calls, monkeypatch):
    """put_events() can return normally while FailedEntryCount says the one
    entry inside it was rejected — that must not look like a success."""
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: {
            "FailedEntryCount": 1,
            "Entries": [{"ErrorCode": "InternalFailure", "ErrorMessage": "boom"}],
        },
    )
    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    response = client.patch(f"/api/v1/orders/{order_id}/delivery-status", json={"delivery_status": "SHIPPED"})

    assert response.status_code == 200
    assert response.json()["delivery_status"] == "SHIPPED"


def test_admin_order_list_spans_every_customer(calls):
    """The customer-scoped GET /api/v1/orders cannot see across customers —
    this is the deliberately separate, admin-gated capability that can."""
    first = client.post("/api/v1/orders", json=basket(customer_id="cust-a")).json()["order_id"]
    second = client.post("/api/v1/orders", json=basket(customer_id="cust-b")).json()["order_id"]

    seen = {o["order_id"] for o in client.get("/api/v1/orders/admin").json()["items"]}
    assert {first, second} <= seen


# ---------------------------------------------------------------------------
# payment_method on every terminal event (CP-020) — the admin toast needs to
# distinguish card from cash-on-delivery, not just the outcome
# ---------------------------------------------------------------------------

def test_confirmed_card_order_event_carries_payment_method(calls):
    client.post("/api/v1/orders", json=basket())
    data = json.loads(outbox_records()[0]["payload"])["data"]
    assert data["payment_method"] == "card"
    assert data["status"] == states.CONFIRMED


def test_confirmed_cash_on_delivery_order_event_carries_payment_method(calls):
    client.post("/api/v1/orders", json=basket(payment_method="cash_on_delivery"))
    data = json.loads(outbox_records()[0]["payload"])["data"]
    assert data["payment_method"] == "cash_on_delivery"
    assert data["status"] == states.PENDING_ON_DELIVERY


def test_rejected_order_event_carries_the_payment_method_that_was_chosen(calls, monkeypatch):
    """_reject fires before the card/COD branch — the event still owes the
    admin dashboard an accurate payment_method for whichever was chosen."""
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))
    client.post("/api/v1/orders", json=basket(payment_method="cash_on_delivery"))
    data = json.loads(outbox_records()[0]["payload"])["data"]
    assert data["payment_method"] == "cash_on_delivery"
    assert data["status"] == states.REJECTED


def test_declined_card_order_event_carries_payment_method(calls, monkeypatch):
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    client.post("/api/v1/orders", json=basket())
    data = json.loads(outbox_records()[0]["payload"])["data"]
    assert data["payment_method"] == "card"
    assert data["status"] == states.FAILED


# ---------------------------------------------------------------------------
# OrderNeedsReconciliation publishing (CP-020) — best-effort, fires only on
# COMPENSATION_FAILED, the one terminal state that publishes no ordinary
# event at all (see test_failed_compensation_is_a_visible_terminal_state)
# ---------------------------------------------------------------------------

def test_compensation_failure_publishes_needs_reconciliation(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    published = []
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: published.append(kwargs) or {},
    )
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    monkeypatch.setattr(clients, "release_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory unreachable")
    ))

    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    assert len(published) == 1
    entry = published[0]["Entries"][0]
    assert entry["Source"] == "smartretailx.orders"
    assert entry["DetailType"] == "OrderNeedsReconciliation"
    detail = json.loads(entry["Detail"])
    assert "event_id" in detail
    data = detail["data"]
    assert data["order_id"] == order_id
    assert "release failed" in data["reason"]
    assert "correlation_id" in data


def test_stock_outcome_unknown_publishes_needs_reconciliation(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    published = []
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: published.append(kwargs) or {},
    )
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("no response from inventory: timeout")
    ))

    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    assert len(published) == 1
    data = json.loads(published[0]["Entries"][0]["Detail"])["data"]
    assert data["order_id"] == order_id


def test_payment_outcome_unknown_publishes_needs_reconciliation(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    published = []
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: published.append(kwargs) or {},
    )
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamUnknown("payment service returned 500")
    ))

    order_id = client.post("/api/v1/orders", json=basket()).json()["order_id"]

    assert len(published) == 1
    data = json.loads(published[0]["Entries"][0]["Detail"])["data"]
    assert data["order_id"] == order_id
    assert data["payment_id"] is None


def test_a_reconciliation_publish_failure_does_not_fail_the_response(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")

    def boom(**kwargs):
        raise RuntimeError("EventBridge is unreachable")

    monkeypatch.setattr("app.events._events_client.put_events", boom)
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    monkeypatch.setattr(clients, "release_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory unreachable")
    ))

    response = client.post("/api/v1/orders", json=basket())

    assert response.status_code == 201
    assert response.json()["status"] == states.COMPENSATION_FAILED


def test_a_rejected_reconciliation_entry_is_treated_as_a_failure(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", "test-bus")
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: {
            "FailedEntryCount": 1,
            "Entries": [{"ErrorCode": "InternalFailure", "ErrorMessage": "boom"}],
        },
    )
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    monkeypatch.setattr(clients, "release_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory unreachable")
    ))

    response = client.post("/api/v1/orders", json=basket())

    assert response.status_code == 201
    assert response.json()["status"] == states.COMPENSATION_FAILED


def test_no_reconciliation_publish_attempted_when_event_bus_name_is_unset(calls, monkeypatch):
    monkeypatch.setattr(config, "EVENT_BUS_NAME", None)
    published = []
    monkeypatch.setattr(
        "app.events._events_client.put_events",
        lambda **kwargs: published.append(kwargs) or {},
    )
    monkeypatch.setattr(clients, "charge_payment", lambda *a, **k: (_ for _ in ()).throw(
        DownstreamRejected(402, "Card declined by issuer", {"payment_id": "pay-x"})
    ))
    monkeypatch.setattr(clients, "release_stock", lambda items: (_ for _ in ()).throw(
        DownstreamUnknown("inventory unreachable")
    ))

    client.post("/api/v1/orders", json=basket())

    assert published == []


# ---------------------------------------------------------------------------
# Admin order summary — the analytics panel's backend
# ---------------------------------------------------------------------------

def test_order_summary_aggregates_todays_orders(calls, monkeypatch):
    client.post("/api/v1/orders", json=basket())
    client.post("/api/v1/orders", json=basket(payment_method="cash_on_delivery"))
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))
    client.post("/api/v1/orders", json=basket())

    summary = client.get("/api/v1/orders/admin/summary").json()

    assert summary["total_orders"] == 3
    assert summary["by_status"][states.CONFIRMED] == 1
    assert summary["by_status"][states.PENDING_ON_DELIVERY] == 1
    assert summary["by_status"][states.REJECTED] == 1
    assert summary["by_payment_method"]["card"] == 2
    assert summary["by_payment_method"]["cash_on_delivery"] == 1


def test_order_summary_revenue_excludes_rejected_and_failed(calls, monkeypatch):
    client.post("/api/v1/orders", json=basket())  # CONFIRMED, $20.00
    monkeypatch.setattr(clients, "reserve_stock", lambda items: (_ for _ in ()).throw(
        DownstreamRejected(409, "Insufficient stock for: p1")
    ))
    client.post("/api/v1/orders", json=basket())  # REJECTED — never charged

    summary = client.get("/api/v1/orders/admin/summary").json()

    assert summary["total_orders"] == 2
    assert summary["total_revenue"] == "20.00"
    # Average order value is revenue over SUCCESSFUL orders only (1 here,
    # not 2) — the standard meaning of the term. Diluting it across a
    # REJECTED order that was never charged would understate it and not
    # match what the label says.
    assert summary["average_order_value"] == "20.00"


def test_order_summary_with_no_orders_today_is_all_zeroes(calls):
    summary = client.get("/api/v1/orders/admin/summary").json()

    assert summary == {
        "total_orders": 0,
        "total_revenue": "0",
        "average_order_value": "0",
        "by_status": {},
        "by_payment_method": {},
    }
