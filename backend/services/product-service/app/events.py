import json
import logging
from datetime import datetime, timezone
from uuid import uuid4

import boto3
from botocore.exceptions import ClientError

from app import config

logger = logging.getLogger(__name__)

EVENT_SOURCE = "smartretailx.catalogue"

_client = None


def get_client():
    global _client
    if _client is None:
        _client = boto3.client("events", region_name=config.AWS_REGION)
    return _client


def publish_product_created(product: dict) -> bool:
    if not config.EVENT_BUS_NAME:
        logger.warning("EVENT_BUS_NAME not set; skipping event publication")
        return False

    detail = {
        "event_id": str(uuid4()),
        "event_version": "1.0",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "data": {
            "product_id": product["id"],
            "name": product["name"],
        },
    }

    try:
        response = get_client().put_events(
            Entries=[{
                "EventBusName": config.EVENT_BUS_NAME,
                "Source": EVENT_SOURCE,
                "DetailType": "ProductCreated",
                "Detail": json.dumps(detail),
            }]
        )

        if response["FailedEntryCount"] > 0:
            entry = response["Entries"][0]
            logger.error(
                "EventBridge rejected ProductCreated for %s: %s %s",
                product["id"],
                entry.get("ErrorCode"),
                entry.get("ErrorMessage"),
            )
            return False

        logger.info(
            "Published ProductCreated event_id=%s product_id=%s",
            detail["event_id"],
            product["id"],
        )
        return True

    except ClientError as exc:
        logger.error(
            "Failed to publish ProductCreated for %s: %s",
            product["id"],
            exc,
            exc_info=True,
        )
        return False
