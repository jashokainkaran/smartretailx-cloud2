import json
import logging

import boto3

from app import config, repository
from app.correlation import current_correlation_id

logger = logging.getLogger(__name__)

_events_client = boto3.client("events", region_name=config.AWS_REGION)


def publish_stock_changed(product_id: str) -> None:
    """Best-effort, direct publish after a successful stock mutation — not a
    transactional outbox. If this fails, or is never called, nothing is
    lost: DynamoDB already has the correct available/reserved counts, and
    the next normal page load shows them. This is deliberately a weaker
    guarantee than the order-outbox pattern, which exists precisely because
    OrderConfirmed/OrderFailed cannot be allowed to silently vanish — a
    missed live stock tick is not in that category."""
    if not config.EVENT_BUS_NAME:
        return  # unset locally; nothing to publish to
    item = repository.get_stock(product_id)
    if item is None:
        return
    try:
        response = _events_client.put_events(Entries=[{
            "Source": "smartretailx.inventory",
            "DetailType": "StockLevelChanged",
            "EventBusName": config.EVENT_BUS_NAME,
            "Detail": json.dumps({
                "data": {
                    "product_id": product_id,
                    "available": int(item["available_quantity"]),
                    "reserved": int(item["reserved_quantity"]),
                    "correlation_id": current_correlation_id(),
                }
            }),
        }])
        # put_events() can return a 200-level "success" for the call itself
        # while rejecting the one entry inside it — FailedEntryCount is not
        # reflected as an exception, so it has to be checked explicitly or a
        # rejected publish looks identical to a delivered one.
        if response.get("FailedEntryCount", 0) > 0:
            error = response["Entries"][0].get("ErrorMessage", "unknown error")
            raise RuntimeError(f"EventBridge rejected the entry: {error}")
    except Exception:
        logger.exception("Failed to publish StockLevelChanged product_id=%s", product_id)
