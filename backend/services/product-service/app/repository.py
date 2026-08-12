import boto3
import uuid
from app import config
from app.models import ProductCreate, Product
import json
import base64
from decimal import Decimal

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

# Create a connection ("resource") to DynamoDB using our config.
dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=config.DYNAMODB_ENDPOINT,
    region_name=config.AWS_REGION,
    aws_access_key_id="local",       # dummy values — DynamoDB Local ignores them
    aws_secret_access_key="local",   # in the cloud, real credentials are used instead
)

# A handle to our specific table.
table = dynamodb.Table(config.PRODUCTS_TABLE)


def create_product(data: ProductCreate) -> Product:
    product = Product(id=str(uuid.uuid4()), **data.model_dump())
    item = _floats_to_decimal(product.model_dump())   # convert floats → Decimal
    table.put_item(Item=item)
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