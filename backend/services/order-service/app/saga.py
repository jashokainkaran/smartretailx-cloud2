"""
The checkout saga (ADR-028): orchestrated, not choreographed.

Three operations across two services — reserve stock, take payment, confirm
the reservation — any of which can fail after the earlier ones have already
succeeded. There is no distributed transaction available across them, so
correctness comes from compensating actions rather than rollback.

Two rules govern every branch below.

1. State is written BEFORE the call it describes, never after (ADR-033).
   Writing state after a successful call leaves a window where the action
   has happened and nothing records it: stock held with no evidence, or
   money taken with no trace. Writing intent first inverts the failure
   mode — the worst case becomes a record claiming something that may not
   have happened, which is checkable, rather than an action nobody knows
   about, which is invisible.

2. A refusal and a non-answer are different things and get opposite
   treatment. A refusal (DownstreamRejected) is a known outcome and is
   compensated. A non-answer (DownstreamUnknown) is compensated under NO
   circumstances, because undoing something that never happened is how you
   refund a customer who was never charged, or invent stock that does not
   exist. Uncertainty is recorded and escalated to a human instead
   (ADR-034 for payments, and the same reasoning for stock).

The ordering of the steps is itself a decision: stock is reserved BEFORE
the card is charged. When you get to choose which step is allowed to fail,
choose the one that is not about money. A failed reserve costs nobody
anything; a failed anything-after-payment owes a refund.
"""

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from app import clients, repository, states
from app.clients import DownstreamRejected, DownstreamUnknown
from app.models import Order, OrderCreate, OrderLineItem

logger = logging.getLogger(__name__)


class BasketInvalid(Exception):
    """
    The basket cannot be priced, so no order is created at all.

    This is deliberately different from running out of stock. A stock
    failure produces a REJECTED order record, because the check is racy,
    involves a write to another service, and the customer deserves an audit
    trail explaining what happened. Pricing is a pure read with no side
    effects — if it fails, nothing happened anywhere and there is nothing
    to audit, so the request is refused at the boundary instead.
    """


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _price_basket(request: OrderCreate):
    """
    Resolve every line against the catalogue and compute the total.

    The client never sends a price. If it did, anyone with developer tools
    open could buy anything for a penny — this function is the reason that
    attack does not exist here.

    The prices resolved here are SNAPSHOTTED onto the order. An order is a
    historical record of an agreement, not a live view of the catalogue: if
    the price changes tomorrow, this order must still show what the
    customer actually agreed to pay.
    """
    product_ids = [item.product_id for item in request.items]
    catalogue = clients.fetch_products(product_ids)

    missing = sorted({pid for pid in product_ids if pid not in catalogue})
    if missing:
        raise BasketInvalid(f"Unknown product(s): {', '.join(missing)}")

    # Deactivated products are returned by the batch endpoint rather than
    # filtered out (ADR-037), precisely so this check can tell a withdrawn
    # product from a non-existent one and say which happened.
    inactive = sorted({
        pid for pid in product_ids if not catalogue[pid].get("active", True)
    })
    if inactive:
        raise BasketInvalid(f"Product(s) no longer for sale: {', '.join(inactive)}")

    line_items = []
    total = Decimal("0.00")
    for item in request.items:
        product = catalogue[item.product_id]
        # str() first: the price arrives as a JSON string (ADR-039), and
        # going through str() rather than float() is what preserves it
        # exactly.
        unit_price = Decimal(str(product["price"]))
        line_items.append(OrderLineItem(
            product_id=item.product_id,
            quantity=item.quantity,
            unit_price=unit_price,
            name=product["name"],
        ))
        total += unit_price * item.quantity

    return line_items, total


# ---------------------------------------------------------------------------
# Terminal transitions. Each one is its own function so that every ending an
# order can have is named, findable, and testable in isolation.
# ---------------------------------------------------------------------------


def _reject(order_id: str, customer_id: str, reason: str):
    """
    Out of stock. Nothing was taken, so there is nothing to compensate —
    the reserve transaction is all-or-nothing, so a failure leaves every
    product in the basket exactly as it was.
    """
    logger.info("order rejected order_id=%s reason=%s", order_id, reason)
    return repository.set_status_and_publish(
        order_id,
        states.RESERVING_STOCK,
        states.REJECTED,
        event_type="OrderFailed",
        event_data={
            "order_id": order_id,
            "customer_id": customer_id,
            "status": states.REJECTED,
            "reason": reason,
        },
        failure_reason=reason,
    )


def _compensate_release(order_id, customer_id, line_items, reason, payment_id):
    """
    The card was declined. Undo the reservation and fail the order.

    Safe to do because a 402 is a definite answer: the Payment service
    reached the provider, got a decline, and recorded it. No money moved.

    There is no retry before giving up. ADR-035 rejected silent
    retry-then-log because it buries a financial discrepancy in a log line;
    a bounded retry queue is the correct production design and was deferred
    on time, with COMPENSATION_FAILED as the fallback it would still need.
    """
    try:
        clients.release_stock(line_items)
    except (DownstreamRejected, DownstreamUnknown) as exc:
        # The compensation itself failed. The customer has no goods and no
        # charge, but stock is stranded in `reserved` where nobody can buy
        # it. Surface it loudly rather than absorbing it (ADR-035).
        logger.error(
            "compensation failed order_id=%s action=release error=%s", order_id, exc
        )
        return repository.set_status(
            order_id,
            states.TAKING_PAYMENT,
            states.COMPENSATION_FAILED,
            failure_reason=f"payment declined ({reason}); stock release failed: {exc}",
            payment_id=payment_id,
        )

    logger.info("order failed order_id=%s reason=%s (stock released)", order_id, reason)
    return repository.set_status_and_publish(
        order_id,
        states.TAKING_PAYMENT,
        states.FAILED,
        event_type="OrderFailed",
        event_data={
            "order_id": order_id,
            "customer_id": customer_id,
            "status": states.FAILED,
            "reason": reason,
        },
        failure_reason=reason,
        payment_id=payment_id,
    )


def _compensate_refund(order_id, customer_id, payment_id, reason):
    """
    Payment succeeded but the stock could not be confirmed. Refund.

    The refund is idempotent on the Payment service's side — a repeated
    refund returns the original refunded_at with already_refunded=True — so
    a retry here cannot double-refund.
    """
    try:
        clients.refund_payment(payment_id)
    except (DownstreamRejected, DownstreamUnknown) as exc:
        # The worst outcome in the system: the customer has been charged
        # and will not receive goods. Terminal, alarmed, and resolved by a
        # human (ADR-035).
        logger.error(
            "compensation failed order_id=%s action=refund payment_id=%s error=%s",
            order_id, payment_id, exc,
        )
        return repository.set_status(
            order_id,
            states.CONFIRMING_STOCK,
            states.COMPENSATION_FAILED,
            failure_reason=f"stock confirm failed ({reason}); refund failed: {exc}",
            payment_id=payment_id,
        )

    logger.info("order failed order_id=%s reason=%s (payment refunded)", order_id, reason)
    return repository.set_status_and_publish(
        order_id,
        states.CONFIRMING_STOCK,
        states.FAILED,
        event_type="OrderFailed",
        event_data={
            "order_id": order_id,
            "customer_id": customer_id,
            "status": states.FAILED,
            "reason": reason,
        },
        failure_reason=reason,
        payment_id=payment_id,
    )


def _confirm_cash_on_delivery(order_id: str, customer_id: str, line_items, total: Decimal):
    """
    No payment step for cash on delivery: confirm the reservation directly
    and close the order out awaiting payment at the door.

    If the confirm itself is rejected, there is nothing to refund — nothing
    was ever charged — so this mirrors the card path's own _compensate_refund
    at this exact step: no stock release is attempted here either. Per
    ADR-040, reservations are not tracked per-order, so a release at this
    specific point (after reserve already succeeded, at confirm) would
    operate on an aggregate counter the saga cannot safely attribute back to
    this order — the same reasoning the payment path already accepts here,
    just with no payment to undo on top of it.
    """
    repository.set_status(order_id, states.RESERVING_STOCK, states.CONFIRMING_STOCK)
    try:
        clients.confirm_stock(line_items)
    except DownstreamRejected as exc:
        reason = str(exc.detail)
        logger.info(
            "order failed order_id=%s reason=%s (cash on delivery, nothing charged)",
            order_id, reason,
        )
        return repository.set_status_and_publish(
            order_id,
            states.CONFIRMING_STOCK,
            states.FAILED,
            event_type="OrderFailed",
            event_data={
                "order_id": order_id,
                "customer_id": customer_id,
                "status": states.FAILED,
                "reason": reason,
            },
            failure_reason=reason,
        )
    except DownstreamUnknown as exc:
        return _stock_unknown(order_id, states.CONFIRMING_STOCK, str(exc))

    logger.info("order confirmed (cash on delivery) order_id=%s", order_id)
    return repository.set_status_and_publish(
        order_id,
        states.CONFIRMING_STOCK,
        states.PENDING_ON_DELIVERY,
        event_type="OrderConfirmed",
        event_data={
            "order_id": order_id,
            "customer_id": customer_id,
            "total": str(total),
            "status": states.PENDING_ON_DELIVERY,
            "items": [
                {"product_id": i.product_id, "quantity": i.quantity} for i in line_items
            ],
        },
    )


def _payment_unknown(order_id: str, reason: str):
    """
    The payment call gave no usable answer. The card may or may not have
    been charged, and we cannot tell from here.

    Do NOT release the stock: if the customer has in fact paid, releasing
    their goods back onto the shelf is a second error on top of the first.
    Do NOT refund: refunding a charge that never happened is a financial
    error in its own right, and the Payment service rejects a refund of an
    UNKNOWN payment with 409 for exactly this reason (ADR-034).

    So: record the uncertainty, alarm on it, and let a human reconcile
    against the PSP. No event is published — nothing downstream should act
    on an order whose outcome is genuinely undetermined.
    """
    logger.error("payment outcome unknown order_id=%s reason=%s", order_id, reason)
    return repository.set_status(
        order_id,
        states.TAKING_PAYMENT,
        states.PAYMENT_UNKNOWN,
        failure_reason=f"payment outcome not observed: {reason}",
    )


def _stock_unknown(order_id, from_state, reason, payment_id=None):
    """
    An inventory call gave no usable answer.

    Reached from two places, and they differ in how much is at stake:

      from RESERVING_STOCK  — no money has moved. The units may or may not
                              be held.
      from CONFIRMING_STOCK — the customer HAS paid. The units may or may
                              not have been deducted.

    Either way the saga cannot determine what happened and cannot find out
    afterwards, because nothing records which order holds which units — the
    gap ADR-040 specifies and deliberately leaves unimplemented. Guessing
    is worse than admitting: assuming failure leaks stock permanently and
    silently, and issuing a release invents stock that never existed and
    reintroduces overselling.
    """
    logger.error(
        "stock outcome unknown order_id=%s from=%s reason=%s", order_id, from_state, reason
    )
    return repository.set_status(
        order_id,
        from_state,
        states.STOCK_UNKNOWN,
        failure_reason=f"inventory outcome not observed at {from_state}: {reason}",
        payment_id=payment_id,
    )


# ---------------------------------------------------------------------------
# The saga proper.
# ---------------------------------------------------------------------------


def run_checkout(request: OrderCreate):
    """
    Run the full checkout, returning the order in its terminal state.

    Synchronous: the caller waits for the outcome rather than polling. The
    frontend gets a definitive answer with no polling loop to build. The
    accepted cost is that a client timeout leaves the customer unsure even
    though the saga completes correctly server-side — which is exactly why
    the order record, not the HTTP response, is the source of truth.
    """
    # Pricing happens BEFORE any order record exists. It is a pure read; if
    # it fails, nothing has happened anywhere.
    line_items, total = _price_basket(request)

    now = _now()
    order = Order(
        order_id=str(uuid.uuid4()),
        customer_id=request.customer_id,
        items=line_items,
        total=total,
        shipping_address=request.shipping_address,
        contact_email=request.contact_email,
        contact_phone=request.contact_phone,
        payment_method=request.payment_method,
        status=states.PENDING,
        created_at=now,
        updated_at=now,
    )
    repository.create_order(order)
    order_id = order.order_id
    customer_id = order.customer_id

    # --- Step 1: reserve stock, all-or-nothing --------------------------
    repository.set_status(order_id, states.PENDING, states.RESERVING_STOCK)
    try:
        clients.reserve_stock(line_items)
    except DownstreamRejected as exc:
        # 409 — at least one line is short. The transaction guarantees
        # nothing at all was reserved, so there is nothing to undo.
        return _reject(order_id, customer_id, str(exc.detail))
    except DownstreamUnknown as exc:
        return _stock_unknown(order_id, states.RESERVING_STOCK, str(exc))

    # Cash on delivery takes no payment now, so the saga has nothing left to
    # do but confirm the reservation. Branching here, right after the one
    # step both payment methods share, keeps the two paths from silently
    # drifting apart on how they reserve stock.
    if request.payment_method == "cash_on_delivery":
        return _confirm_cash_on_delivery(order_id, customer_id, line_items, total)

    # --- Step 2: take payment -------------------------------------------
    repository.set_status(order_id, states.RESERVING_STOCK, states.TAKING_PAYMENT)
    try:
        payment = clients.charge_payment(order_id, total, request.payment_token)
    except DownstreamRejected as exc:
        # 402 — declined. The Payment service returns the full Payment
        # record on a decline rather than an error envelope, so payment_id
        # and failure_reason are both available even though nothing was
        # charged. exc.detail falls back to the raw response text here (see
        # clients._detail) because this response has no "detail" key — read
        # failure_reason from .body instead, the same way payment_id already
        # is, rather than storing the whole serialized Payment record.
        declined_payment_id = (exc.body or {}).get("payment_id")
        declined_reason = (exc.body or {}).get("failure_reason") or str(exc.detail)
        return _compensate_release(
            order_id, customer_id, line_items, declined_reason, declined_payment_id
        )
    except DownstreamUnknown as exc:
        return _payment_unknown(order_id, str(exc))

    payment_id = payment["payment_id"]

    # --- Step 3: confirm the reservation --------------------------------
    repository.set_status(
        order_id, states.TAKING_PAYMENT, states.CONFIRMING_STOCK, payment_id=payment_id
    )
    try:
        clients.confirm_stock(line_items)
    except DownstreamRejected as exc:
        return _compensate_refund(order_id, customer_id, payment_id, str(exc.detail))
    except DownstreamUnknown as exc:
        return _stock_unknown(order_id, states.CONFIRMING_STOCK, str(exc), payment_id)

    # --- Done ------------------------------------------------------------
    logger.info("order confirmed order_id=%s payment_id=%s", order_id, payment_id)
    return repository.set_status_and_publish(
        order_id,
        states.CONFIRMING_STOCK,
        states.CONFIRMED,
        event_type="OrderConfirmed",
        event_data={
            "order_id": order_id,
            "customer_id": customer_id,
            "total": str(total),
            "items": [
                {"product_id": i.product_id, "quantity": i.quantity} for i in line_items
            ],
        },
        payment_id=payment_id,
    )
