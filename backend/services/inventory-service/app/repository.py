import boto3
from decimal import Decimal
from botocore.exceptions import ClientError
from app import config


def _floats_to_decimal(obj):
    # Recursively convert floats to Decimal so DynamoDB will accept them.
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _floats_to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_floats_to_decimal(v) for v in obj]
    return obj


dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=config.DYNAMODB_ENDPOINT,
    region_name=config.AWS_REGION,
    aws_access_key_id="local",       # dummy values — DynamoDB Local ignores them
    aws_secret_access_key="local",   # in the cloud, real credentials are used instead
)

table = dynamodb.Table(config.INVENTORY_TABLE)


def get_stock(product_id: str):
    """Fetch the stock record for a product. Returns None if it doesn't exist."""
    response = table.get_item(Key={"product_id": product_id})
    return response.get("Item")


def reserve_stock(product_id: str, quantity: int):
    """
    Reserve `quantity` units. Atomically moves units available -> reserved,
    but ONLY if enough are available. This single conditional write is what
    prevents overselling under concurrent requests.
    Raises ValueError if there isn't enough stock.
    """
    try:
        response = table.update_item(
            Key={"product_id": product_id},
            UpdateExpression=(
                "SET available_quantity = available_quantity - :qty, "
                "reserved_quantity = reserved_quantity + :qty"
            ),
            ConditionExpression="available_quantity >= :qty",
            ExpressionAttributeValues={":qty": quantity},
            ReturnValues="ALL_NEW",
        )
        return response["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # Condition failed — not enough stock available.
            raise ValueError("Insufficient stock available")
        raise


def release_stock(product_id: str, quantity: int):
    """
    Release `quantity` previously-reserved units (e.g. cancelled checkout).
    Atomically moves units reserved -> available, but ONLY if that many are
    actually reserved (so you can't release more than was held).
    Raises ValueError if trying to release more than is reserved.
    """
    try:
        response = table.update_item(
            Key={"product_id": product_id},
            UpdateExpression=(
                "SET available_quantity = available_quantity + :qty, "
                "reserved_quantity = reserved_quantity - :qty"
            ),
            ConditionExpression="reserved_quantity >= :qty",
            ExpressionAttributeValues={":qty": quantity},
            ReturnValues="ALL_NEW",
        )
        return response["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValueError("Cannot release more than is reserved")
        raise

def confirm_stock(product_id: str, quantity: int):
    """
    Confirm a sale: permanently remove `quantity` units from reserved
    (the goods have been paid for and are leaving inventory).
    Atomically decrements reserved_quantity, but ONLY if that many are
    actually reserved. available_quantity is NOT touched — those units
    were already moved out of available when they were reserved.
    Raises ValueError if trying to confirm more than is reserved.
    """
    try:
        response = table.update_item(
            Key={"product_id": product_id},
            UpdateExpression="SET reserved_quantity = reserved_quantity - :qty",
            ConditionExpression="reserved_quantity >= :qty",
            ExpressionAttributeValues={":qty": quantity},
            ReturnValues="ALL_NEW",
        )
        return response["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValueError("Cannot confirm more than is reserved")
        raise

def add_stock(product_id: str, quantity: int):
    """
    Add `quantity` units to available stock (e.g. a delivery/restock, or
    creating an initial record). Uses an atomic increment; if the record
    doesn't exist yet, it's created with the given available quantity and
    zero reserved.
    """
    response = table.update_item(
        Key={"product_id": product_id},
        UpdateExpression=(
            "SET available_quantity = if_not_exists(available_quantity, :zero) + :qty, "
            "reserved_quantity = if_not_exists(reserved_quantity, :zero)"
        ),
        ExpressionAttributeValues={":qty": quantity, ":zero": 0},
        ReturnValues="ALL_NEW",
    )
    return response["Attributes"]