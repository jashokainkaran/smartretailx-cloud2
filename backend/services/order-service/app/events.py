import json
import logging
import uuid

import boto3

from app import config
from app.correlation import current_correlation_id

logger = logging.getLogger(__name__)

_events_client = boto3.client("events", region_name=config.AWS_REGION)


def _raise_if_rejected(response: dict) -> None:
    """put_events() can return a 200-level "success" for the call itself
    while rejecting the one entry inside it — FailedEntryCount is not
    reflected as an exception, so it has to be checked explicitly or a
    rejected publish looks identical to a delivered one."""
    if response.get("FailedEntryCount", 0) > 0:
        error = response["Entries"][0].get("ErrorMessage", "unknown error")
        raise RuntimeError(f"EventBridge rejected the entry: {error}")


def publish_needs_reconciliation(order_id: str, reason: str, payment_id: str | None) -> None:
    """Best-effort, direct publish — not the transactional order_outbox
    path. Fires only when a compensating action itself fails
    (COMPENSATION_FAILED, ADR-035): money or stock is stuck in an
    inconsistent state pending a human, which is exactly the case an admin
    watching the live dashboard feed needs to see immediately. If this
    publish fails, or is never called, the order is still discoverable via
    the existing /orders/stuck query — nothing is silently lost, only the
    live push."""
    if not config.EVENT_BUS_NAME:
        return  # unset locally; nothing to publish to
    try:
        response = _events_client.put_events(Entries=[{
            "Source": "smartretailx.orders",
            "DetailType": "OrderNeedsReconciliation",
            "EventBusName": config.EVENT_BUS_NAME,
            "Detail": json.dumps({
                "data": {
                    "order_id": order_id,
                    "reason": reason,
                    "payment_id": payment_id,
                    "correlation_id": current_correlation_id(),
                }
            }),
        }])
        _raise_if_rejected(response)
    except Exception:
        logger.exception("Failed to publish OrderNeedsReconciliation order_id=%s", order_id)


def publish_delivery_status_changed(order: dict) -> None:
    """Best-effort, direct publish — not the transactional order_outbox
    path. A delivery status update is operational bookkeeping (see
    update_delivery_status()'s own docstring), not the definitive
    financial outcome OrderConfirmed/OrderFailed represent, so it doesn't
    need that path's stronger guarantee: if one status-change email is
    missed, the order's true state is still correct in DynamoDB and
    visible on the customer's own order history, and the next status
    change (very possibly DELIVERED) still gets its own email.

    `order` is the raw DynamoDB item dict repository.set_delivery_status()
    returns — not a validated Order model, since FastAPI's response_model
    coercion happens after this call, not before.

    Unlike the outbox-based events, this has no natural event_id to key
    Notification's idempotency check on — the outbox table's own hash key
    fills that role for OrderConfirmed/OrderFailed, but this never touches
    the outbox at all. A fresh UUID per publish is the id Notification
    checks against; a genuine SQS redelivery of the SAME publish carries
    the SAME id (it's part of the message body, not regenerated on retry),
    so the idempotency guarantee still holds — it just isn't tied to a
    durable source-of-truth record the way the outbox-based one is."""
    if not config.EVENT_BUS_NAME:
        return  # unset locally; nothing to publish to
    order_id = order["order_id"]
    try:
        response = _events_client.put_events(Entries=[{
            "Source": "smartretailx.orders",
            "DetailType": "DeliveryStatusChanged",
            "EventBusName": config.EVENT_BUS_NAME,
            "Detail": json.dumps({
                "event_id": str(uuid.uuid4()),
                "data": {
                    "order_id": order_id,
                    "contact_email": order["contact_email"],
                    "recipient_name": order["shipping_address"]["recipient_name"],
                    "delivery_status": order["delivery_status"],
                    "correlation_id": current_correlation_id(),
                }
            }),
        }])
        _raise_if_rejected(response)
    except Exception:
        logger.exception("Failed to publish DeliveryStatusChanged order_id=%s", order_id)
