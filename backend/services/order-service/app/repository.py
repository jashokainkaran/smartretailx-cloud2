import boto3
import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer

from app import config, states
from app.models import Order

logger = logging.getLogger(__name__)

# The event source string is a module constant, not configuration: it is
# part of the event contract and is identical in every environment
# (ADR-021). Contrast with the service URLs in config.py, which are
# locations and therefore configuration.
EVENT_SOURCE = "smartretailx.orders"
EVENT_VERSION = "1.0"

# Same connection pattern as every other service (ADR-025). One dict feeds
# both clients, so credentials and endpoint cannot drift apart.
_dynamodb_kwargs = {"region_name": config.AWS_REGION}
if config.DYNAMODB_ENDPOINT:
    _dynamodb_kwargs.update({
        "endpoint_url": config.DYNAMODB_ENDPOINT,
        "aws_access_key_id": "local",
        "aws_secret_access_key": "local",
    })

dynamodb = boto3.resource("dynamodb", **_dynamodb_kwargs)
table = dynamodb.Table(config.ORDERS_TABLE)

# Transactions are not exposed by the resource API, so the outbox write
# needs the low-level client as well.
dynamodb_client = boto3.client("dynamodb", **_dynamodb_kwargs)

_serializer = TypeSerializer()


def check_health() -> None:
    """Raise if this service cannot reach its own DynamoDB table."""
    dynamodb_client.describe_table(TableName=config.ORDERS_TABLE)


def _to_dynamo(item: dict) -> dict:
    """Convert a plain Python dict into DynamoDB's wire format."""
    return {k: _serializer.serialize(v) for k, v in item.items()}


def _now() -> str:
    """UTC, explicitly. created_at is a GSI range key — an ambiguous
    timestamp corrupts sort order, not merely a display field."""
    return datetime.now(timezone.utc).isoformat()


def create_order(order: Order) -> Order:
    """
    Write the order in its initial state, before the saga touches anything.

    saga_status is a SEPARATE attribute holding the same value as status.
    It exists only to drive the sparse saga-status GSI, and is REMOVEd when
    the order reaches a healthy terminal state — at which point the item
    loses a value for the index's hash key and drops out of the index
    entirely.

    The conditional write means a retried POST cannot overwrite an
    in-flight order and restart its saga.
    """
    item = order.model_dump()
    item["saga_status"] = order.status
    # A constant partition key for all-orders-index (the admin Customers &
    # Orders view) — see orders.tf for why a Query against a fixed key beats
    # a table Scan for "every order, newest first".
    item["order_bucket"] = "ALL"

    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(order_id)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValueError(f"Order {order.order_id} already exists")
        raise

    logger.info("order created order_id=%s status=%s", order.order_id, order.status)
    return order


def get_order(order_id: str):
    """Fetch one order. Returns None if it doesn't exist."""
    return table.get_item(Key={"order_id": order_id}).get("Item")


def _build_update(new_status, expected_status, failure_reason, payment_id):
    """
    Assemble the UpdateExpression shared by both the plain and the
    transactional paths, so the two cannot drift apart.
    """
    # "status" is a DynamoDB reserved word and must go through a name
    # placeholder. Everything else is routed the same way for consistency,
    # rather than tracking which words happen to be reserved (ADR-038).
    names = {"#status": "status", "#saga_status": "saga_status"}
    values = {
        ":new": new_status,
        ":expected": expected_status,
        ":now": _now(),
    }
    set_parts = ["#status = :new", "updated_at = :now"]
    remove_parts = []

    if failure_reason is not None:
        set_parts.append("failure_reason = :reason")
        values[":reason"] = failure_reason

    if payment_id is not None:
        set_parts.append("payment_id = :payment_id")
        values[":payment_id"] = payment_id

    # The sparse-index rule, in one branch.
    #
    # Healthy terminal state (CONFIRMED, REJECTED, FAILED) -> REMOVE
    # saga_status, so the item drops out of the recovery index.
    #
    # Everything else -> keep saga_status in step with status. That covers
    # in-flight states AND the terminal states that need a human
    # (PAYMENT_UNKNOWN, STOCK_UNKNOWN, COMPENSATION_FAILED), which must
    # stay visible.
    if new_status in states.TERMINAL and new_status not in states.NEEDS_ATTENTION:
        remove_parts.append("#saga_status")
    else:
        set_parts.append("#saga_status = :new")

    expression = "SET " + ", ".join(set_parts)
    if remove_parts:
        expression += " REMOVE " + ", ".join(remove_parts)

    return expression, names, values


def _conditional_failure(order_id, expected_status, new_status):
    """
    A failed condition means one of two things and DynamoDB does not say
    which, so re-read to find out.
    """
    current = get_order(order_id)
    if current is None:
        return ValueError(f"Order {order_id} does not exist")
    return ValueError(
        f"Order {order_id} is in state {current['status']}, expected "
        f"{expected_status} — refusing to move it to {new_status}"
    )


def set_status(
    order_id: str,
    expected_status: str,
    new_status: str,
    failure_reason: str | None = None,
    payment_id: str | None = None,
):
    """
    Move the order from one state to the next, but ONLY if it is currently
    in the state the caller expects.

    This conditional write is the most important line in the file. It is
    what makes the saga safe against a duplicate or concurrent run: two
    invocations for the same order cannot both advance it, because the
    second one's condition fails against a state that has already moved on.
    It is the same primitive as available_quantity >= :qty in Inventory —
    the correctness condition lives inside the atomic write rather than in
    a read-then-write somebody hopes is not interleaved.
    """
    expression, names, values = _build_update(
        new_status, expected_status, failure_reason, payment_id
    )

    try:
        response = table.update_item(
            Key={"order_id": order_id},
            UpdateExpression=expression,
            ConditionExpression="#status = :expected",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        raise _conditional_failure(order_id, expected_status, new_status)

    logger.info(
        "order state change order_id=%s %s -> %s",
        order_id, expected_status, new_status,
    )
    return response["Attributes"]


def set_status_and_publish(
    order_id: str,
    expected_status: str,
    new_status: str,
    event_type: str,
    event_data: dict,
    failure_reason: str | None = None,
    payment_id: str | None = None,
):
    """
    Move the order to a terminal state AND record the event it owes, in one
    atomic transaction (ADR-020).

    The reason this is a transaction rather than two writes is the dual-write
    problem: writing CONFIRMED and then failing to publish OrderConfirmed
    would leave a paid, confirmed order that no downstream consumer — the
    Notification service, for instance — ever hears about, with nothing
    anywhere recording that a publish was owed. The event cannot be made
    atomic with the state change, but the DECISION to publish can, because
    both are DynamoDB writes.

    The relay Lambda picks the outbox record up from the table's stream and
    publishes it to EventBridge. Duplicate delivery is possible and
    accepted — the relay may publish and crash before marking the record
    sent — because at-least-once already requires idempotent consumers
    (ADR-022).
    """
    expression, names, values = _build_update(
        new_status, expected_status, failure_reason, payment_id
    )

    event_id = str(uuid.uuid4())
    envelope = {
        "event_id": event_id,
        "event_version": EVENT_VERSION,
        "occurred_at": _now(),
        "data": event_data,
    }

    outbox_record = {
        "event_id": event_id,
        "event_type": event_type,
        # The publisher owns its source string (ADR-021), so it travels
        # with the record rather than being configured on the relay. The
        # relay simply forwards whatever it finds here.
        "event_source": EVENT_SOURCE,
        # Stored as a JSON string so the relay can hand it to EventBridge
        # untouched, without needing to know the shape of any event.
        "payload": json.dumps(envelope, default=str),
        "created_at": _now(),
        # The relay REMOVEs this attribute on publication, which is what
        # makes the recovery GSI sparse and stops the relay re-triggering
        # on its own write.
        "status": "PENDING",
    }

    try:
        dynamodb_client.transact_write_items(TransactItems=[
            {
                "Update": {
                    "TableName": config.ORDERS_TABLE,
                    "Key": {"order_id": {"S": order_id}},
                    "UpdateExpression": expression,
                    "ConditionExpression": "#status = :expected",
                    "ExpressionAttributeNames": names,
                    "ExpressionAttributeValues": _to_dynamo(values),
                }
            },
            {
                "Put": {
                    "TableName": config.ORDER_OUTBOX_TABLE,
                    "Item": _to_dynamo(outbox_record),
                    "ConditionExpression": "attribute_not_exists(event_id)",
                }
            },
        ])
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        raise _conditional_failure(order_id, expected_status, new_status)

    logger.info(
        "order state change order_id=%s %s -> %s event=%s",
        order_id, expected_status, new_status, event_type,
    )
    # transact_write_items has no ReturnValues equivalent, so re-read.
    return get_order(order_id)


def list_orders_by_customer(customer_id: str, limit: int = 20, cursor: dict | None = None):
    """
    A customer's orders, newest first, via customer-orders-index.

    Returns (items, last_evaluated_key). Without this index, listing one
    customer's orders would be a full Scan with a filter — cost proportional
    to every order in the system rather than to the few being returned.
    """
    kwargs = {
        "IndexName": "customer-orders-index",
        "KeyConditionExpression": Key("customer_id").eq(customer_id),
        "ScanIndexForward": False,   # descending on created_at = newest first
        "Limit": limit,
    }
    if cursor:
        kwargs["ExclusiveStartKey"] = cursor

    response = table.query(**kwargs)
    return response.get("Items", []), response.get("LastEvaluatedKey")


def list_all_orders(limit: int = 20, cursor: dict | None = None):
    """
    Every order, across every customer, newest first — the admin Customers &
    Orders view. Queries all-orders-index rather than scanning the table:
    order_bucket is a constant ("ALL") set on every order at write time, so
    this costs proportional to what is actually returned, not to the whole
    table (see orders.tf for the full reasoning and its own tradeoff).

    Returns (items, last_evaluated_key), the same shape as
    list_orders_by_customer, so the route handler doesn't need to know which
    one it called.
    """
    kwargs = {
        "IndexName": "all-orders-index",
        "KeyConditionExpression": Key("order_bucket").eq("ALL"),
        "ScanIndexForward": False,   # newest first, same convention as list_orders_by_customer
        "Limit": limit,
    }
    if cursor:
        kwargs["ExclusiveStartKey"] = cursor

    response = table.query(**kwargs)
    return response.get("Items", []), response.get("LastEvaluatedKey")


def set_delivery_status(order_id: str, delivery_status: str):
    """
    Record fulfilment progress. Guarded only by "the order must actually be
    confirmed" (CONFIRMED or PENDING_ON_DELIVERY) — unlike set_status, this
    is not a conditional state-machine transition, because delivery status
    is operational bookkeeping an admin corrects by hand, not a safety
    property two concurrent processes could race on.
    """
    try:
        response = table.update_item(
            Key={"order_id": order_id},
            UpdateExpression="SET delivery_status = :ds, updated_at = :now",
            ConditionExpression=(
                "attribute_exists(order_id) AND #status IN (:confirmed, :cod)"
            ),
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":ds": delivery_status,
                ":now": _now(),
                ":confirmed": states.CONFIRMED,
                ":cod": states.PENDING_ON_DELIVERY,
            },
            ReturnValues="ALL_NEW",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        current = get_order(order_id)
        if current is None:
            raise ValueError(f"Order {order_id} does not exist")
        raise ValueError(
            f"Order {order_id} is in state {current['status']} — only a "
            "confirmed order (CONFIRMED or PENDING_ON_DELIVERY) can have its "
            "delivery status set"
        )

    return response["Attributes"]


def list_orders_needing_attention():
    """
    Every order a human must resolve: PAYMENT_UNKNOWN, STOCK_UNKNOWN and
    COMPENSATION_FAILED.

    One query per status, because a GSI hash key can only be queried with
    equality — there is no "give me every value of saga_status". That
    constraint is why NEEDS_ATTENTION is a small, closed set.
    """
    results = []
    for status in sorted(states.NEEDS_ATTENTION):
        response = table.query(
            IndexName="saga-status-index",
            KeyConditionExpression=Key("saga_status").eq(status),
        )
        results.extend(response.get("Items", []))
    return results
