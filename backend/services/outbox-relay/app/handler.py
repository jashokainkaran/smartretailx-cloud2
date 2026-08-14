import os
import json
import logging
import time
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.types import TypeDeserializer

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

EVENT_BUS_NAME = os.environ["EVENT_BUS_NAME"]
OUTBOX_TABLE = os.environ["OUTBOX_TABLE"]

# Fallback source, used when an outbox record does not carry its own.
#
# The relay now serves more than one outbox (product catalogue and orders),
# deployed as separate Lambdas from this same image with different
# OUTBOX_TABLE values — the one-image-many-entrypoints pattern of ADR-024.
#
# The source string is NOT configuration on this Lambda, because ADR-021
# says the source is part of the event contract and belongs to the
# publisher. So the publisher writes `event_source` into its own outbox
# record and the relay simply forwards it. This constant remains only for
# records written before that field existed — every product outbox record
# currently in DynamoDB — so the relay stays backward compatible without a
# migration.
DEFAULT_EVENT_SOURCE = "smartretailx.catalogue"
TTL_DAYS = 7

_deserializer = TypeDeserializer()
_events = boto3.client("events")
_dynamodb = boto3.client("dynamodb")


def _from_dynamo(image: dict) -> dict:
    return {k: _deserializer.deserialize(v) for k, v in image.items()}


def handler(event, context):
    published = 0
    skipped = 0

    for record in event.get("Records", []):
        if record.get("eventName") not in ("INSERT", "MODIFY"):
            skipped += 1
            continue

        image = record.get("dynamodb", {}).get("NewImage")
        if not image:
            skipped += 1
            continue

        item = _from_dynamo(image)

        # Already published — this is the relay's own update re-triggering
        # the stream. Without this guard the relay loops forever.
        if "status" not in item:
            skipped += 1
            continue

        event_id = item["event_id"]
        event_type = item["event_type"]
        payload = item["payload"]
        event_source = item.get("event_source", DEFAULT_EVENT_SOURCE)

        _events.put_events(
            Entries=[{
                "EventBusName": EVENT_BUS_NAME,
                "Source": event_source,
                "DetailType": event_type,
                "Detail": payload,
            }]
        )

        now = datetime.now(timezone.utc).isoformat()
        ttl = int(time.time()) + (TTL_DAYS * 86400)

        _dynamodb.update_item(
            TableName=OUTBOX_TABLE,
            Key={"event_id": {"S": event_id}},
            UpdateExpression="REMOVE #s SET published_at = :p, #t = :t",
            ExpressionAttributeNames={"#s": "status", "#t": "ttl"},
            ExpressionAttributeValues={
                ":p": {"S": now},
                ":t": {"N": str(ttl)},
            },
        )

        logger.info("Published %s event_id=%s", event_type, event_id)
        published += 1

    logger.info("Relay batch complete: published=%d skipped=%d", published, skipped)
    return {"published": published, "skipped": skipped}
