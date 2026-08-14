import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

from app import config
from app.models import Payment
from app.providers import get_provider

logger = logging.getLogger(__name__)


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

table = dynamodb.Table(config.PAYMENTS_TABLE)


def charge(order_id: str, amount: Decimal, payment_token: str) -> Payment:
    """
    Charge a payment through the configured provider and record the
    result. The repository owns persistence and state transitions only —
    all PSP behaviour goes through the provider (app/providers).

    The record is written BEFORE the provider is called, as PENDING, and
    updated afterwards — never the other way around. If the provider call
    itself raises (a real PSP timing out after the card was actually
    charged, for example), writing the record only on return would leave
    no trace that the provider was ever invoked, and money could be taken
    with nothing to show for it. Recording intent first means the worst
    case is an UNKNOWN record awaiting reconciliation, not a silent loss.
    This is the same principle as the transactional outbox in ADR-020: an
    unrecorded action is invisible, an action recorded but not completed
    is checkable.

    already_refunded is excluded from every write in this file — it
    describes what happened in a refund call, not a property of the
    payment, so it must never appear in the stored item (not even as an
    explicit null).
    """
    payment_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    pending = Payment(
        payment_id=payment_id,
        order_id=order_id,
        amount=amount,
        status="PENDING",
        created_at=now,
    )
    item = _floats_to_decimal(pending.model_dump(exclude={"already_refunded"}))
    table.put_item(Item=item)

    try:
        result = get_provider().charge(amount, payment_token, idempotency_key=payment_id)
    except Exception as exc:
        logger.info(
            "Charge outcome unknown payment_id=%s order_id=%s exception=%s",
            payment_id, order_id, exc,
        )
        table.update_item(
            Key={"payment_id": payment_id},
            UpdateExpression="SET #status = :unknown, failure_reason = :reason",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":unknown": "UNKNOWN",
                ":reason": str(exc),
            },
        )
        raise

    if result.succeeded:
        logger.info(
            "Charge succeeded payment_id=%s order_id=%s status=%s",
            payment_id, order_id, "SUCCEEDED",
        )
        response = table.update_item(
            Key={"payment_id": payment_id},
            UpdateExpression="SET #status = :status, transaction_reference = :ref",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "SUCCEEDED",
                ":ref": result.transaction_reference,
            },
            ReturnValues="ALL_NEW",
        )
    else:
        logger.info(
            "Charge declined payment_id=%s order_id=%s failure_reason=%s",
            payment_id, order_id, result.failure_reason,
        )
        response = table.update_item(
            Key={"payment_id": payment_id},
            UpdateExpression="SET #status = :status, failure_reason = :reason",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "FAILED",
                ":reason": result.failure_reason,
            },
            ReturnValues="ALL_NEW",
        )

    return Payment(**response["Attributes"])


def get_payment(payment_id: str) -> Payment | None:
    response = table.get_item(Key={"payment_id": payment_id})
    item = response.get("Item")
    if item is None:
        return None
    return Payment(**item)


def refund(payment_id: str) -> Payment | None:
    """
    Refund a previously succeeded payment.

    Must be idempotent — the saga may retry a refund, and refunding twice
    would be a genuine financial defect. The pre-check below decides
    whether it's even correct to call the provider (a FAILED or UNKNOWN
    payment has no confirmed charge to refund; an already-REFUNDED payment
    shouldn't be asked again) — it is not what makes this safe. Safety
    comes from the ConditionExpression on the state transition below, which
    only allows SUCCEEDED -> REFUNDED, so a concurrent or retried refund
    can never double-apply regardless of what the pre-check observed.

    already_refunded on the returned record distinguishes "refunded just
    now" (False) from "was already refunded" (True), for client feedback.
    It never changes the status code — that stays 200 either way, since a
    repeated call is not an error under this idempotent contract. It
    describes what happened in THIS call, not a property of the payment,
    so it is never persisted — only set on the returned model.
    """
    payment = get_payment(payment_id)
    if payment is None:
        return None
    if payment.status == "FAILED":
        raise ValueError("Cannot refund a failed payment")
    if payment.status == "UNKNOWN":
        raise ValueError("Cannot refund a payment with an unknown outcome")
    if payment.status == "PENDING":
        raise ValueError("Cannot refund a payment that is still in progress")
    if payment.status == "REFUNDED":
        # The normal repeat-call path: the pre-check itself already caught
        # it, so this never reaches the ConditionExpression below.
        logger.info("Refund already performed payment_id=%s", payment_id)
        return payment.model_copy(update={"already_refunded": True})

    get_provider().refund(payment.transaction_reference, idempotency_key=payment_id)

    refunded_at = datetime.now(timezone.utc).isoformat()

    # "status" is a DynamoDB reserved word — routed through a placeholder.
    try:
        response = table.update_item(
            Key={"payment_id": payment_id},
            UpdateExpression="SET #status = :refunded, refunded_at = :refunded_at",
            ConditionExpression="attribute_exists(payment_id) AND #status = :succeeded",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":refunded": "REFUNDED",
                ":refunded_at": refunded_at,
                ":succeeded": "SUCCEEDED",
            },
            ReturnValues="ALL_NEW",
        )
        logger.info("Refund performed payment_id=%s", payment_id)
        return Payment(**response["Attributes"]).model_copy(update={"already_refunded": False})
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        # The transition wasn't SUCCEEDED -> REFUNDED. Read back and work
        # out why: already refunded is a success, a failed payment is not.
        # Reachable only via the race the pre-check can't see: a concurrent
        # refund that completes between our pre-check and this write.
        record = get_payment(payment_id)
        if record is None:
            return None
        if record.status == "REFUNDED":
            logger.info("Refund already performed payment_id=%s", payment_id)
            return record.model_copy(update={"already_refunded": True})
        raise ValueError("Cannot refund a failed payment")
