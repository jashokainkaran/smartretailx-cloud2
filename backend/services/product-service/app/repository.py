import boto3
import uuid
from app import config
from app.models import ProductCreate, Product
import json
import base64
from decimal import Decimal
from boto3.dynamodb.types import TypeSerializer
from datetime import datetime, timezone

def _floats_to_decimal(obj):
    # Recursively convert floats to Decimal so DynamoDB will accept them.
    if isinstance(obj, float):
        # Convert via str() to avoid inheriting float's imprecision.
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _floats_to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_floats_to_decimal(v) for v in obj]
    return obj

# Shared connection kwargs for both the resource and the client, so they
# cannot drift apart.
#
# Locally, DYNAMODB_ENDPOINT points at DynamoDB Local, which needs dummy
# credentials since it doesn't check them. On AWS, DYNAMODB_ENDPOINT is
# unset — we pass region only, so boto3 resolves the real DynamoDB
# endpoint and the Lambda execution role's temporary credentials.
_dynamodb_kwargs = {"region_name": config.AWS_REGION}
if config.DYNAMODB_ENDPOINT:
    _dynamodb_kwargs.update({
        "endpoint_url": config.DYNAMODB_ENDPOINT,
        "aws_access_key_id": "local",
        "aws_secret_access_key": "local",
    })

# Create a connection ("resource") to DynamoDB using our config.
dynamodb = boto3.resource("dynamodb", **_dynamodb_kwargs)

# A handle to our specific table.
table = dynamodb.Table(config.PRODUCTS_TABLE)

# The low-level client. Transactions are not exposed by the resource API.
dynamodb_client = boto3.client("dynamodb", **_dynamodb_kwargs)

_serializer = TypeSerializer()


def _to_dynamo(item: dict) -> dict:
    """Convert a plain Python dict into DynamoDB's wire format."""
    return {k: _serializer.serialize(v) for k, v in item.items()}


def create_product(data: ProductCreate) -> Product:
    product = Product(id=str(uuid.uuid4()), **data.model_dump())
    item = _floats_to_decimal(product.model_dump())

    now = datetime.now(timezone.utc).isoformat()
    event_id = str(uuid.uuid4())

    event_payload = {
        "event_id": event_id,
        "event_version": "1.0",
        "occurred_at": now,
        "data": {
            "product_id": product.id,
            "name": product.name,
        },
    }

    outbox_item = {
        "event_id": event_id,
        "event_type": "ProductCreated",
        "payload": json.dumps(event_payload),
        "created_at": now,
        "status": "PENDING",
    }

    dynamodb_client.transact_write_items(
        TransactItems=[
            {"Put": {"TableName": config.PRODUCTS_TABLE, "Item": _to_dynamo(item)}},
            {"Put": {"TableName": config.OUTBOX_TABLE, "Item": _to_dynamo(outbox_item)}},
        ]
    )

    return product


def get_product(product_id: str) -> Product | None:
    response = table.get_item(Key={"id": product_id})
    item = response.get("Item")
    if item is None:
        return None
    return Product(**item)


def list_products(limit: int = 20, cursor: str | None = None):
    # Build the scan request: read at most `limit` items.
    scan_kwargs = {"Limit": limit}

    # If the client sent a cursor, decode it back into DynamoDB's key format
    # and tell DynamoDB to resume from there.
    if cursor:
        start_key = json.loads(base64.urlsafe_b64decode(cursor).decode())
        scan_kwargs["ExclusiveStartKey"] = start_key

    response = table.scan(**scan_kwargs)

    items = [Product(**item) for item in response.get("Items", [])]

    # DynamoDB returns a LastEvaluatedKey ONLY if there are more pages.
    # If present, encode it into a text cursor to hand back to the client.
    next_cursor = None
    last_key = response.get("LastEvaluatedKey")
    if last_key:
        next_cursor = base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()

    return items, next_cursor