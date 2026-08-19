import json
import logging

from app import repository
from app.push import push_to_connections

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def handler(event, context):
    """SQS-triggered Lambda. Consumes five event types routed here by
    EventBridge, and pushes a live update to the relevant open WebSocket
    connections:

    - StockLevelChanged (Inventory) -> everyone connected (public data).
    - OrderConfirmed / OrderFailed (Order — the SAME rules that already feed
      Notification's receipt emails) -> admin connections only, as the toast
      the admin dashboard shows the moment an order resolves.
    - OrderNeedsReconciliation (Order) -> admin connections only, the
      COMPENSATION_FAILED case that otherwise publishes no event at all.
    - DeliveryStatusChanged (Order) -> admin connections only, so the
      ready-to-ship card stays current in every open admin dashboard.

    All five are published best-effort by their source service — not
    through a transactional outbox — so this consumer makes no durability
    promise either: a message that never arrives here, or a push that
    fails, loses nothing that matters, since DynamoDB already has the
    correct state and the next normal page load (or the existing
    /orders/stuck query, for reconciliation) shows it.

    The event source mapping has ReportBatchItemFailures enabled, so one
    bad record in a batch (a JSON parse error, an unrecognised detail-type,
    a DynamoDB error looking up connections) is reported as that record's
    own failure rather than left to raise and fail the whole invocation —
    without this, SQS would retry every message in the batch, including
    the ones already pushed successfully, showing an admin the same toast
    twice for one genuinely new event.
    """
    pushed = 0
    batch_item_failures = []

    for record in event.get("Records", []):
        try:
            body = json.loads(record["body"])
            detail_type = body["detail-type"]
            detail = body["detail"]
            data = detail["data"]
            event_id = detail.get("event_id")

            if detail_type == "StockLevelChanged":
                connection_ids = repository.all_connections()
                payload = {
                    "type": "StockUpdated",
                    "product_id": data["product_id"],
                    "available": data["available"],
                    "reserved": data["reserved"],
                }
            elif detail_type in ("OrderConfirmed", "OrderFailed"):
                # Deliberately only the fields the toast needs — not
                # contact_email/recipient_name, even though this only ever
                # reaches admin connections.
                connection_ids = repository.admin_connections()
                payload = {
                    "type": "OrderResolved",
                    "event_id": event_id,
                    "order_id": data["order_id"],
                    "status": data["status"],
                    "payment_method": data.get("payment_method"),
                    "reason": data.get("reason"),
                }
            elif detail_type == "OrderNeedsReconciliation":
                connection_ids = repository.admin_connections()
                payload = {
                    "type": "OrderNeedsReconciliation",
                    "event_id": event_id,
                    "order_id": data["order_id"],
                    "reason": data["reason"],
                }
            elif detail_type == "DeliveryStatusChanged":
                connection_ids = repository.admin_connections()
                payload = {
                    "type": "DeliveryStatusChanged",
                    "event_id": event_id,
                    "order_id": data["order_id"],
                    "delivery_status": data["delivery_status"],
                }
            else:
                logger.warning("Unrecognised detail-type, skipping: %s", detail_type)
                continue

            push_to_connections(connection_ids, payload)
            pushed += 1
            logger.info(
                "Pushed %s to %d connection(s) correlation_id=%s",
                detail_type, len(connection_ids), data.get("correlation_id"),
            )
        except Exception:
            logger.exception("Failed to process record messageId=%s", record.get("messageId"))
            batch_item_failures.append({"itemIdentifier": record["messageId"]})

    return {"pushed": pushed, "batchItemFailures": batch_item_failures}
