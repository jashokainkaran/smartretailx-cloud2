import boto3

from app import config

# Same connection pattern as every other service (ADR-025).
_dynamodb_kwargs = {"region_name": config.AWS_REGION}
if config.DYNAMODB_ENDPOINT:
    _dynamodb_kwargs.update({
        "endpoint_url": config.DYNAMODB_ENDPOINT,
        "aws_access_key_id": "local",
        "aws_secret_access_key": "local",
    })

dynamodb = boto3.resource("dynamodb", **_dynamodb_kwargs)
table = dynamodb.Table(config.NOTIFICATIONS_TABLE)


def already_sent(event_id: str) -> bool:
    """A plain read, not a conditional write — deliberately. The handler
    checks this BEFORE sending and calls mark_sent() only AFTER a
    successful send, so a failure never gets recorded as done. Marking
    first (the same shape the Inventory consumer uses for
    create_stock_record) would be wrong here: creating a stock record IS
    the outcome, but marking-sent and actually-sending-the-email are two
    separate actions, and a mid-way crash between them must not make a
    genuinely unsent receipt look sent."""
    return "Item" in table.get_item(Key={"event_id": event_id})


def mark_sent(event_id: str) -> None:
    """Called only once send_receipt() has actually returned successfully."""
    table.put_item(Item={"event_id": event_id})
