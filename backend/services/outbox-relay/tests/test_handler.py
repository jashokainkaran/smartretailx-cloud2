"""Behavioural tests for the DynamoDB Streams outbox relay.

The relay is intentionally small but safety-critical: it is the bridge from
the durable outbox to EventBridge. These tests replace its AWS clients with
in-memory recorders and prove that it publishes once, marks only a successful
record complete, and ignores the DynamoDB Stream update it caused itself.
"""

from __future__ import annotations

import json
import os

os.environ.setdefault("EVENT_BUS_NAME", "test-event-bus")
os.environ.setdefault("OUTBOX_TABLE", "TestOutbox")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-west-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")

from app import handler


class RecordingEvents:
    def __init__(self, response: dict | None = None):
        self.response = response or {"FailedEntryCount": 0}
        self.calls: list[dict] = []

    def put_events(self, *, Entries: list[dict]) -> dict:
        self.calls.append({"Entries": Entries})
        return self.response


class RecordingDynamo:
    def __init__(self):
        self.calls: list[dict] = []

    def update_item(self, **kwargs) -> None:
        self.calls.append(kwargs)


def stream_record(*, status: bool = True, event_source: str | None = None) -> dict:
    image = {
        "event_id": {"S": "event-123"},
        "event_type": {"S": "ProductCreated"},
        "payload": {"S": json.dumps({"product_id": "product-1"})},
    }
    if status:
        image["status"] = {"S": "PENDING"}
    if event_source:
        image["event_source"] = {"S": event_source}
    return {"eventName": "INSERT", "dynamodb": {"NewImage": image}}


def test_successful_record_is_published_and_marked_complete(monkeypatch):
    events = RecordingEvents()
    dynamo = RecordingDynamo()
    monkeypatch.setattr(handler, "_events", events)
    monkeypatch.setattr(handler, "_dynamodb", dynamo)

    result = handler.handler({"Records": [stream_record(event_source="smartretailx.orders")]}, None)

    assert result == {"published": 1, "skipped": 0}
    assert events.calls[0]["Entries"][0] == {
        "EventBusName": "test-event-bus",
        "Source": "smartretailx.orders",
        "DetailType": "ProductCreated",
        "Detail": '{"product_id": "product-1"}',
    }
    assert dynamo.calls[0]["TableName"] == "TestOutbox"
    assert dynamo.calls[0]["Key"] == {"event_id": {"S": "event-123"}}
    assert dynamo.calls[0]["UpdateExpression"] == "REMOVE #s SET published_at = :p, #t = :t"


def test_relay_update_without_status_is_skipped(monkeypatch):
    events = RecordingEvents()
    dynamo = RecordingDynamo()
    monkeypatch.setattr(handler, "_events", events)
    monkeypatch.setattr(handler, "_dynamodb", dynamo)

    result = handler.handler({"Records": [stream_record(status=False)]}, None)

    assert result == {"published": 0, "skipped": 1}
    assert events.calls == []
    assert dynamo.calls == []


def test_eventbridge_rejection_leaves_outbox_record_pending(monkeypatch):
    events = RecordingEvents({"FailedEntryCount": 1, "Entries": [{"ErrorCode": "InternalFailure"}]})
    dynamo = RecordingDynamo()
    monkeypatch.setattr(handler, "_events", events)
    monkeypatch.setattr(handler, "_dynamodb", dynamo)

    try:
        handler.handler({"Records": [stream_record()]}, None)
    except RuntimeError as exc:
        assert "EventBridge rejected" in str(exc)
    else:
        raise AssertionError("A rejected EventBridge entry must fail the Lambda batch for retry.")

    assert len(events.calls) == 1
    assert dynamo.calls == []
