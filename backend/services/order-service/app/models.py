from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
from pydantic import BaseModel, Field, field_serializer


def _two_places(value: Decimal) -> str:
    """
    Serialise a monetary amount with exactly two decimal places.

    DynamoDB discards trailing zeros, so a total stored as 20.50 reads back
    as 20.5 and would go over the wire as "20.5". quantize only pads —
    30.89 stays 30.89 — so this stabilises the format without touching the
    value. ROUND_HALF_UP is unreachable given decimal_places=2 validation,
    but is stated rather than inheriting Python's banker's rounding.

    Amounts are US dollars (USD); two decimal places is correct for cents
    and is assumed system-wide (see ADR-039).
    """
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


class OrderItemRequest(BaseModel):
    """
    One basket line, as the CLIENT sends it.

    Deliberately carries NO price. If the browser supplied unit_price,
    anyone with developer tools open could buy a television for a penny.
    The Order service fetches the price from the Product Catalogue itself
    and snapshots it into OrderLineItem below. Trusting a client-supplied
    price is one of the most common real-world checkout vulnerabilities,
    and the shape of this model is what makes it impossible here.
    """
    product_id: str
    quantity: int = Field(..., gt=0)


class OrderCreate(BaseModel):
    customer_id: str

    # min_length=1 rejects an empty basket at the API boundary with a 422,
    # before any order record is written and before the saga starts. An
    # empty order is not a business failure to be recorded — it is a
    # malformed request.
    #
    # max_length=100 is a guard on DynamoDB's TransactWriteItems limit of
    # 100 operations. The all-or-nothing reserve builds one Update per
    # DISTINCT product, and duplicate product lines are aggregated before
    # the transaction is built, so 100 lines can only ever produce 100 or
    # fewer operations. This is therefore conservative rather than exact —
    # deliberately, because rejecting here with a clear message beats
    # letting DynamoDB reject with an opaque ValidationException.
    items: list[OrderItemRequest] = Field(..., min_length=1, max_length=100)

    # PSP token — never a card number (ADR-007). Passed through to the
    # Payment service and never persisted on the order: note that no field
    # on Order below can hold it. The boundary is enforced by the shape of
    # the models, not by remembering not to write it.
    payment_token: str


class OrderLineItem(BaseModel):
    """
    One basket line as STORED, with the price resolved server-side.

    unit_price is a deliberate denormalisation. The obvious alternative is
    to store product_id only and look the price up from the catalogue when
    displaying the order — but prices change, and an order placed last
    Tuesday must keep showing the price the customer actually agreed to.
    A stored order is a historical record of an agreement, not a live view
    of the catalogue. Same reasoning for name: the product may later be
    renamed or deactivated (ADR-037) and the order must still render.
    """
    product_id: str
    quantity: int
    unit_price: Decimal
    name: str

    @field_serializer("unit_price")
    def _serialise_unit_price(self, value: Decimal) -> str:
        return _two_places(value)


class Order(BaseModel):
    order_id: str
    customer_id: str
    items: list[OrderLineItem]

    # Computed server-side from the snapshotted line items, never sent by
    # the client, for the same reason unit_price isn't.
    total: Decimal

    @field_serializer("total")
    def _serialise_total(self, value: Decimal) -> str:
        return _two_places(value)

    # One of the values in app/states.py.
    status: str

    # Set once the Payment service has issued a payment_id — which happens
    # BEFORE the provider is called (ADR-034), so this may be populated on
    # an order whose payment ultimately failed or is UNKNOWN. Its presence
    # means "a charge was attempted", not "a charge succeeded".
    payment_id: Optional[str] = None

    failure_reason: Optional[str] = None
    created_at: str
    updated_at: str

    # NOTE (see below): saga_status is NOT on this model. It is a storage-level
    # attribute that exists only to drive the sparse saga-status GSI, and
    # it is REMOVEd when an order reaches a healthy terminal state. It is
    # an index key, not part of the API contract, so it is not exposed to
    # clients — status already tells them everything they need.


class OrderPage(BaseModel):
    """The shape returned by the paginated list endpoint, mirroring ProductPage."""
    items: list[Order]
    next_cursor: Optional[str] = None
