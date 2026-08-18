import json
import logging

from app import repository
from app.emailer import send_receipt

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def handler(event, context):
    """
    SQS-triggered Lambda. Consumes OrderConfirmed/OrderFailed events routed
    here by EventBridge from the Order service's outbox, and sends a
    receipt email — the second, independent subscriber on the event bus
    the Inventory consumer already proved works (ADR-006).

    The event source mapping has ReportBatchItemFailures enabled, so a
    problem with one message in a batch must not silently take the rest
    down with it (an unhandled exception fails the whole batch, matching
    the old default) or get lost entirely (a message we deliberately skip,
    like one with no contact_email, must be reported as a failure so SQS
    keeps it and eventually DLQs it, rather than deleting it as if it had
    been handled).
    """
    sent = 0
    duplicates = 0
    skipped = 0
    batch_item_failures = []

    for record in event.get("Records", []):
        # SQS wraps the message; EventBridge wraps our event inside that —
        # the same shape the Inventory consumer already parses.
        body = json.loads(record["body"])
        detail = body["detail"]
        event_id = detail["event_id"]
        event_type = body["detail-type"]
        data = detail["data"]
        correlation_id = data.get("correlation_id")

        if repository.already_sent(event_id):
            logger.info(
                "Receipt already sent — duplicate delivery ignored "
                "event_id=%s correlation_id=%s",
                event_id, correlation_id,
            )
            duplicates += 1
            continue

        if not data.get("contact_email"):
            # Not expected in normal operation now that every terminal saga
            # branch includes contact_email on its event — logged loudly
            # rather than silently dropped, since it means a receipt is
            # genuinely owed and this service cannot send it. Reported as a
            # batch item failure (not just skipped) so the message isn't
            # deleted — it retries, and reaches the DLQ if it keeps failing.
            logger.error(
                "Event has no contact_email, cannot send a receipt "
                "event_id=%s order_id=%s correlation_id=%s",
                event_id, data.get("order_id"), correlation_id,
            )
            batch_item_failures.append({"itemIdentifier": record["messageId"]})
            skipped += 1
            continue

        send_receipt(event_type, data)
        repository.mark_sent(event_id)
        logger.info(
            "Sent %s receipt event_id=%s order_id=%s correlation_id=%s",
            event_type, event_id, data.get("order_id"), correlation_id,
        )
        sent += 1

    logger.info(
        "Notification batch complete: sent=%d duplicates=%d skipped=%d",
        sent, duplicates, skipped,
    )
    return {
        "sent": sent,
        "duplicates": duplicates,
        "skipped": skipped,
        "batchItemFailures": batch_item_failures,
    }
