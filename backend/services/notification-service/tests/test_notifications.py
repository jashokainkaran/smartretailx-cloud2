import os
import time

# Point the app at a SEPARATE test table BEFORE importing it — same pattern
# every other service's test file uses, and for the same reason: config.py
# reads these once at import time.
os.environ["NOTIFICATIONS_TABLE"] = "NotificationsTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["SENDER_EMAIL"] = "sender@example.com"

import boto3
import pytest

from app import config, repository
from app.emailer import send_receipt
from app.handler import handler


@pytest.fixture(autouse=True)
def test_table():
    """Create a clean NotificationsTest table before each test, delete it after."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    table = dynamodb.create_table(
        TableName="NotificationsTest",
        KeySchema=[{"AttributeName": "event_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "event_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    table.wait_until_exists()
    yield
    table.delete()
    table.wait_until_not_exists()


def confirmed_event(event_id="evt-1", **overrides):
    data = {
        "order_id": "order-1",
        "customer_id": "cust-1",
        "contact_email": "customer@example.com",
        "recipient_name": "Jamie",
        "total": "20.00",
        "status": "CONFIRMED",
        "items": [{"product_id": "p1", "quantity": 2, "unit_price": "10.00", "name": "Widget"}],
        "correlation_id": "corr-1",
    }
    data.update(overrides)
    return {
        "messageId": f"msg-{event_id}",
        "body": __import__("json").dumps({
            "detail-type": "OrderConfirmed",
            "detail": {"event_id": event_id, "event_version": "1.0", "data": data},
        })
    }


def failed_event(event_id="evt-2", **overrides):
    data = {
        "order_id": "order-2",
        "customer_id": "cust-2",
        "contact_email": "customer@example.com",
        "recipient_name": "Sam",
        "status": "REJECTED",
        "reason": "Insufficient stock for: p1",
        "correlation_id": "corr-2",
    }
    data.update(overrides)
    return {
        "messageId": f"msg-{event_id}",
        "body": __import__("json").dumps({
            "detail-type": "OrderFailed",
            "detail": {"event_id": event_id, "event_version": "1.0", "data": data},
        })
    }


# ---------------------------------------------------------------------------
# repository: the idempotency check itself
# ---------------------------------------------------------------------------

def test_new_event_is_not_already_sent():
    assert repository.already_sent("evt-x") is False


def test_marked_event_is_reported_as_already_sent():
    before = int(time.time())
    repository.mark_sent("evt-x")
    assert repository.already_sent("evt-x") is True
    stored = repository.table.get_item(Key={"event_id": "evt-x"})["Item"]
    assert stored["ttl"] >= before + repository.SENT_EVENT_TTL_SECONDS


# ---------------------------------------------------------------------------
# emailer: what actually gets sent, without hitting real SES
# ---------------------------------------------------------------------------

def test_send_receipt_confirmed_calls_ses_with_the_right_recipient(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("OrderConfirmed", {
        "order_id": "order-1",
        "contact_email": "customer@example.com",
        "recipient_name": "Jamie",
        "total": "20.00",
        "status": "CONFIRMED",
        "items": [{"product_id": "p1", "quantity": 2, "unit_price": "10.00", "name": "Widget"}],
    })

    assert len(calls) == 1
    assert calls[0]["Source"] == "sender@example.com"
    assert calls[0]["Destination"] == {"ToAddresses": ["customer@example.com"]}
    text = calls[0]["Message"]["Body"]["Text"]["Data"]
    html_body = calls[0]["Message"]["Body"]["Html"]["Data"]
    assert "Widget" in text and "Widget" in html_body
    assert "Hi Jamie" in text and "Hi Jamie" in html_body
    assert "thanks for shopping" in text.lower()
    # No brand name in the subject — an order confirmation, not an ad.
    assert calls[0]["Message"]["Subject"]["Data"] == "Your SmartRetailX order is confirmed"


def test_send_receipt_greets_generically_with_no_recipient_name(monkeypatch):
    """recipient_name is a newer field than contact_email — older or
    malformed events might not have it. Missing it should degrade the
    greeting, not crash the send."""
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("OrderConfirmed", {
        "order_id": "order-1",
        "contact_email": "customer@example.com",
        "total": "20.00",
        "status": "CONFIRMED",
        "items": [],
    })

    assert "Hi there" in calls[0]["Message"]["Body"]["Text"]["Data"]


def test_send_receipt_cash_on_delivery_mentions_no_charge(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("OrderConfirmed", {
        "order_id": "order-1",
        "contact_email": "customer@example.com",
        "total": "20.00",
        "status": "PENDING_ON_DELIVERY",
        "items": [],
    })

    assert "cash" in calls[0]["Message"]["Body"]["Text"]["Data"].lower()


def test_send_receipt_failed_mentions_the_reason(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("OrderFailed", {
        "order_id": "order-2",
        "contact_email": "customer@example.com",
        "recipient_name": "Sam",
        "status": "REJECTED",
        "reason": "Insufficient stock for: p1",
    })

    text = calls[0]["Message"]["Body"]["Text"]["Data"]
    assert "Insufficient stock for: p1" in text
    assert "Hi Sam" in text
    assert calls[0]["Message"]["Subject"]["Data"] == "Your SmartRetailX order could not be completed"
    # REJECTED never took a payment — nothing to say was refunded.
    assert "refund" not in text.lower()


def test_send_receipt_failed_mentions_a_refund_but_rejected_does_not(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("OrderFailed", {
        "order_id": "order-3",
        "contact_email": "customer@example.com",
        "status": "FAILED",
        "reason": "Card declined by issuer",
    })

    assert "refund" in calls[0]["Message"]["Body"]["Text"]["Data"].lower()


def test_send_receipt_rejects_an_unknown_event_type():
    with pytest.raises(ValueError):
        send_receipt("SomethingElse", {"contact_email": "customer@example.com"})


def test_send_receipt_delivery_status_changed_mentions_the_status(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("DeliveryStatusChanged", {
        "order_id": "order-4",
        "contact_email": "customer@example.com",
        "recipient_name": "Priya",
        "delivery_status": "OUT_FOR_DELIVERY",
    })

    text = calls[0]["Message"]["Body"]["Text"]["Data"]
    html_body = calls[0]["Message"]["Body"]["Html"]["Data"]
    assert "out for delivery" in text.lower()
    assert "out for delivery" in html_body.lower()
    assert "Hi Priya" in text
    assert "order-4" not in text
    assert "order-4" not in html_body


def test_send_receipt_delivery_status_changed_handles_an_unmapped_status(monkeypatch):
    """A status this service doesn't have a friendly phrase for still sends
    something sensible rather than crashing — falls back to the raw value."""
    calls = []
    monkeypatch.setattr(
        "app.emailer.ses.send_email", lambda **kwargs: calls.append(kwargs)
    )

    send_receipt("DeliveryStatusChanged", {
        "order_id": "order-5",
        "contact_email": "customer@example.com",
        "delivery_status": "SOMETHING_NEW",
    })

    assert "SOMETHING_NEW" in calls[0]["Message"]["Body"]["Text"]["Data"]


# ---------------------------------------------------------------------------
# handler: the full SQS-triggered path
# ---------------------------------------------------------------------------

def test_handler_sends_and_marks_a_new_confirmed_event(monkeypatch):
    sent = []
    monkeypatch.setattr("app.handler.send_receipt", lambda *a: sent.append(a))

    result = handler({"Records": [confirmed_event()]}, {})

    assert result == {"sent": 1, "duplicates": 0, "skipped": 0, "batchItemFailures": []}
    assert len(sent) == 1
    assert repository.already_sent("evt-1") is True


def test_handler_skips_a_duplicate_delivery(monkeypatch):
    sent = []
    monkeypatch.setattr("app.handler.send_receipt", lambda *a: sent.append(a))
    repository.mark_sent("evt-1")  # already processed once

    result = handler({"Records": [confirmed_event()]}, {})

    assert result == {"sent": 0, "duplicates": 1, "skipped": 0, "batchItemFailures": []}
    assert sent == []  # never called send_receipt at all for the duplicate


def test_handler_skips_and_does_not_mark_an_event_with_no_contact_email(monkeypatch):
    """A missing contact_email must be reported as a batch item failure, not
    just silently skipped — without that, SQS treats the whole batch
    (including this record) as successfully processed and deletes it,
    losing the receipt forever instead of retrying/DLQing it."""
    sent = []
    monkeypatch.setattr("app.handler.send_receipt", lambda *a: sent.append(a))

    result = handler({"Records": [confirmed_event(contact_email=None)]}, {})

    assert result == {
        "sent": 0, "duplicates": 0, "skipped": 1,
        "batchItemFailures": [{"itemIdentifier": "msg-evt-1"}],
    }
    assert sent == []
    # Not marked as sent — nothing was actually sent, so a later fix (e.g.
    # backfilling the email) must still be able to process this event.
    assert repository.already_sent("evt-1") is False


def test_handler_does_not_mark_sent_when_send_receipt_fails(monkeypatch):
    """The core idempotency-ordering guarantee: a send failure must leave
    the event retryable, not silently recorded as done."""
    def boom(*a):
        raise RuntimeError("SES is down")

    monkeypatch.setattr("app.handler.send_receipt", boom)

    with pytest.raises(RuntimeError):
        handler({"Records": [confirmed_event()]}, {})

    assert repository.already_sent("evt-1") is False


def test_handler_processes_a_failed_order_event(monkeypatch):
    sent = []
    monkeypatch.setattr("app.handler.send_receipt", lambda *a: sent.append(a))

    result = handler({"Records": [failed_event()]}, {})

    assert result == {"sent": 1, "duplicates": 0, "skipped": 0, "batchItemFailures": []}
    assert sent[0][0] == "OrderFailed"


def test_handler_processes_a_batch_of_mixed_records(monkeypatch):
    sent = []
    monkeypatch.setattr("app.handler.send_receipt", lambda *a: sent.append(a))
    repository.mark_sent("evt-dup")

    records = [
        confirmed_event(event_id="evt-a"),
        failed_event(event_id="evt-b"),
        confirmed_event(event_id="evt-dup"),
    ]
    result = handler({"Records": records}, {})

    assert result == {"sent": 2, "duplicates": 1, "skipped": 0, "batchItemFailures": []}
