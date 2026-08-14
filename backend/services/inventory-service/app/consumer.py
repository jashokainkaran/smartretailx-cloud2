import json
import logging

from app import repository

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def handler(event, context):
    """
    SQS-triggered Lambda. Consumes ProductCreated events delivered via
    EventBridge and creates an empty stock record for each new product.
    """
    created = 0
    duplicates = 0

    for record in event.get("Records", []):
        # SQS wraps the message; EventBridge wraps our event inside that.
        # Our payload lives at body["detail"]["data"].
        body = json.loads(record["body"])
        detail = body["detail"]
        event_id = detail["event_id"]
        product_id = detail["data"]["product_id"]

        if repository.create_stock_record(product_id):
            logger.info(
                "Created stock record product_id=%s event_id=%s",
                product_id, event_id,
            )
            created += 1
        else:
            logger.info(
                "Stock record already exists — duplicate delivery ignored "
                "product_id=%s event_id=%s",
                product_id, event_id,
            )
            duplicates += 1

    logger.info(
        "Consumer batch complete: created=%d duplicates=%d", created, duplicates
    )
    return {"created": created, "duplicates": duplicates}
