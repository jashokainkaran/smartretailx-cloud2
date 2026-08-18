import boto3
import uuid
from app import config
from app.models import ProductCreate, Product, ProductUpdate
import json
import base64
from decimal import Decimal
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
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


def check_health() -> None:
    """Raise if this service cannot reach its own DynamoDB table."""
    dynamodb_client.describe_table(TableName=config.PRODUCTS_TABLE)


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


def update_product(product_id: str, data: ProductUpdate) -> Product | None:
    updates = {k: v for k, v in data.model_dump().items() if v is not None}

    if not updates:
        # Nothing to change. DynamoDB rejects an empty UpdateExpression, so
        # just hand back the product as it currently stands.
        return get_product(product_id)

    updates = _floats_to_decimal(updates)

    # Attribute names go through placeholders throughout — "name" is a
    # DynamoDB reserved word, and routing every field through a placeholder
    # avoids having to track which of the rest are safe.
    update_expression = "SET " + ", ".join(f"#{k} = :{k}" for k in updates)
    expression_attribute_names = {f"#{k}": k for k in updates}
    expression_attribute_values = {f":{k}": v for k, v in updates.items()}

    try:
        response = table.update_item(
            Key={"id": product_id},
            UpdateExpression=update_expression,
            ConditionExpression="attribute_exists(id)",
            ExpressionAttributeNames=expression_attribute_names,
            ExpressionAttributeValues=expression_attribute_values,
            ReturnValues="ALL_NEW",
        )
        return Product(**response["Attributes"])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # Condition failed — the product doesn't exist.
            return None
        raise


def set_product_active(product_id: str, active: bool) -> Product | None:
    try:
        response = table.update_item(
            Key={"id": product_id},
            UpdateExpression="SET #active = :active",
            ConditionExpression="attribute_exists(id)",
            ExpressionAttributeNames={"#active": "active"},
            ExpressionAttributeValues={":active": active},
            ReturnValues="ALL_NEW",
        )
        return Product(**response["Attributes"])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        raise


def list_products(limit: int = 20, cursor: str | None = None, include_inactive: bool = False):
    # Build the scan request: read at most `limit` items.
    scan_kwargs = {"Limit": limit}

    if not include_inactive:
        # Products created before `active` existed have no such attribute
        # at all — treat a MISSING active attribute as active, not as
        # inactive, so old records aren't silently hidden.
        scan_kwargs["FilterExpression"] = "attribute_not_exists(#active) OR #active = :true"
        scan_kwargs["ExpressionAttributeNames"] = {"#active": "active"}
        scan_kwargs["ExpressionAttributeValues"] = {":true": True}

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

def batch_get_products(product_ids: list[str]) -> list[Product]:
    """
    Fetch many products in a single round trip, for the Order saga's price
    lookup.

    The saga must never trust a client-supplied price, so it has to resolve
    every basket line against the catalogue before it can compute a total.
    Doing that one GET at a time costs one network round trip per line —
    and, on Lambda, bills the caller for the time it spends waiting on each
    one. BatchGetItem collapses that into a single request.

    Three constraints of BatchGetItem drive this implementation:

    1. Duplicate keys in one request raise ValidationException, so the ids
       are de-duplicated first. dict.fromkeys is used rather than set()
       because it preserves order, which keeps behaviour deterministic and
       the tests readable. This is the same class of bug as duplicate
       product lines in the Inventory reserve transaction.

    2. A maximum of 100 keys per request. Enforced by ProductBatchRequest
       at the API boundary so the caller gets a clear 422 rather than a
       DynamoDB error.

    3. A response may include UnprocessedKeys — DynamoDB is allowed to
       return only part of what was asked for, if the request exceeds
       throughput or size limits. Those keys are NOT an error and are NOT
       retried automatically by boto3's resource-level batch_get_item; the
       caller must resubmit them. The loop below does that. Ignoring this
       would produce a rare, load-dependent bug where a basket silently
       loses a line, which is exactly the kind of failure that never shows
       up in testing.

    Missing products are simply absent from the result. Deciding what that
    means is the caller's job, not the catalogue's: the saga rejects the
    order, because a basket referencing a product that does not exist
    cannot be priced.
    """
    unique_ids = list(dict.fromkeys(product_ids))
    if not unique_ids:
        return []

    found = []
    remaining = [{"id": product_id} for product_id in unique_ids]

    while remaining:
        response = dynamodb.batch_get_item(
            RequestItems={config.PRODUCTS_TABLE: {"Keys": remaining}}
        )
        for item in response["Responses"].get(config.PRODUCTS_TABLE, []):
            found.append(Product(**item))

        unprocessed = response.get("UnprocessedKeys", {}).get(config.PRODUCTS_TABLE, {})
        remaining = unprocessed.get("Keys", [])

    return found
