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


# Shared connection kwargs for the resource, so credentials and endpoint
# cannot drift from what's actually intended per environment.
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

dynamodb = boto3.resource("dynamodb", **_dynamodb_kwargs)

table = dynamodb.Table(config.INVENTORY_TABLE)


def check_health() -> None:
    """Raise if this service cannot reach its own DynamoDB table."""
    table.meta.client.describe_table(TableName=config.INVENTORY_TABLE)


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


def create_stock_record(product_id: str) -> bool:
    """
    Create an empty stock record for a newly-created product.

    Uses a conditional write: the record is only created if one does not
    already exist. This makes the operation idempotent, which matters
    because SQS guarantees at-least-once delivery — the same
    ProductCreated event can legitimately arrive more than once.

    Returns True if a record was created, False if one already existed.
    """
    try:
        table.put_item(
            Item={
                "product_id": product_id,
                "available_quantity": 0,
                "reserved_quantity": 0,
            },
            ConditionExpression="attribute_not_exists(product_id)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise

# The resource API has no transact_write_items. Transactions are only
# available on the low-level client, so this service now needs both. Both
# are built from the same _dynamodb_kwargs, so they cannot drift.
dynamodb_client = boto3.client("dynamodb", **_dynamodb_kwargs)

def _aggregate(items):
    """
    Collapse duplicate product lines into one entry each, preserving order.

    DynamoDB forbids two operations on the SAME item inside a single
    TransactWriteItems call. A basket can perfectly legitimately contain the
    same product on two lines — "2 x widget" added twice — and without this
    the whole transaction fails with a ValidationException that says nothing
    useful about why.

    Python dicts preserve insertion order, which matters more than it looks:
    the transaction below is built by iterating this dict, so the position of
    each product here is the position of its result in CancellationReasons.
    """
    totals = {}
    for item in items:
        totals[item.product_id] = totals.get(item.product_id, 0) + item.quantity
    return totals


def _transact_stock(totals, update_expression, condition_expression, message):
    """
    Apply one conditional update per product, all-or-nothing.

    Every update carries the same condition the single-item functions use.
    The difference is that TransactWriteItems makes them atomic as a group:
    if any one product fails its condition, NONE of the writes land. Partial
    reservation therefore cannot happen, which removes an entire class of
    compensation from the saga.
    """
    transact_items = [
        {
            "Update": {
                "TableName": config.INVENTORY_TABLE,
                "Key": {"product_id": {"S": product_id}},
                "UpdateExpression": update_expression,
                "ConditionExpression": condition_expression,
                # The low-level client needs DynamoDB wire format: every
                # value is {type: value}. "N" takes a STRING, not an int —
                # DynamoDB transmits all numbers as strings to avoid the
                # float precision problems that motivated ADR-039.
                "ExpressionAttributeValues": {":qty": {"N": str(quantity)}},
            }
        }
        for product_id, quantity in totals.items()
    ]

    try:
        dynamodb_client.transact_write_items(TransactItems=transact_items)
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        # CancellationReasons is POSITIONAL: one entry per operation, in the
        # order we submitted them. That is what lets us name the products
        # that actually failed rather than saying "something failed".
        reasons = e.response.get("CancellationReasons", [])
        failed = [
            product_id
            for product_id, reason in zip(totals.keys(), reasons)
            if reason.get("Code") == "ConditionalCheckFailed"
        ]
        raise ValueError(f"{message}: {', '.join(failed)}")


def reserve_many(items):
    """Reserve every line atomically. Nothing is reserved unless all of it is."""
    _transact_stock(
        _aggregate(items),
        "SET available_quantity = available_quantity - :qty, "
        "reserved_quantity = reserved_quantity + :qty",
        "available_quantity >= :qty",
        "Insufficient stock for",
    )


def release_many(items):
    """Compensating action: return reserved units to available."""
    _transact_stock(
        _aggregate(items),
        "SET available_quantity = available_quantity + :qty, "
        "reserved_quantity = reserved_quantity - :qty",
        "reserved_quantity >= :qty",
        "Cannot release more than is reserved for",
    )


def confirm_many(items):
    """Goods are paid for and leaving inventory. available_quantity untouched."""
    _transact_stock(
        _aggregate(items),
        "SET reserved_quantity = reserved_quantity - :qty",
        "reserved_quantity >= :qty",
        "Cannot confirm more than is reserved for",
    )
