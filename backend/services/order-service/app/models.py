import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_serializer, field_validator, model_validator

# Deliberately not pydantic's EmailStr: that needs the email-validator
# package, an extra dependency for a check that only needs to catch typos
# at the API boundary. Real delivery is proven by SES actually sending, not
# by a stricter regex here.
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

PaymentMethod = Literal["card", "cash_on_delivery"]

# Fulfilment tracking, distinct from the saga's own `status`. This is a plain
# forward progression an admin sets by hand — not a safety-critical state
# machine like the saga's, so there is no conditional-transition guard here:
# an admin can move it to any value at any time, the same way a real courier
# dashboard would let staff correct a mis-click.
DeliveryStatus = Literal["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]


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

    ``expected_unit_price`` is the price the customer SAW when adding an
    item to their basket. It is never trusted as the charge amount: the
    Order service still obtains the current authoritative price from the
    Product Catalogue. It lets checkout stop with a clear 409 when those
    two values differ, instead of silently charging a changed price.

    In contrast, ``unit_price`` is deliberately not accepted as a charge
    instruction. The server snapshots its own catalogue price into
    OrderLineItem below; developer tools cannot turn a television into a
    one-penny purchase by changing this request.
    """
    product_id: str
    quantity: int = Field(..., gt=0)
    expected_unit_price: Decimal = Field(..., gt=0, max_digits=12, decimal_places=2)


class ShippingAddress(BaseModel):
    """Where the order is delivered. Required on every order, card or COD —
    even a card payment has to arrive somewhere."""
    recipient_name: str = Field(..., min_length=1)
    street: str = Field(..., min_length=1)
    city: str = Field(..., min_length=1)
    postal_code: str = Field(..., min_length=1)
    country: str = Field(..., min_length=1)


class OrderCreate(BaseModel):
    # The API accepts no customer identity from the browser. The route handler
    # fills this from the verified Cognito subject before the saga starts.
    customer_id: Optional[str] = None

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

    shipping_address: ShippingAddress
    contact_email: str
    contact_phone: str = Field(..., min_length=7, max_length=20)

    payment_method: PaymentMethod

    # PSP token — never a card number (ADR-007). Passed through to the
    # Payment service and never persisted on the order: note that no field
    # on Order below can hold it. The boundary is enforced by the shape of
    # the models, not by remembering not to write it.
    #
    # Optional here, not required: cash on delivery takes no payment at
    # checkout, so there is nothing to tokenise. The validator below is what
    # actually enforces "required when paying by card" — Optional alone
    # would let a card order through with no token at all.
    payment_token: Optional[str] = None

    @field_validator("contact_email")
    @classmethod
    def _valid_email(cls, value: str) -> str:
        if not _EMAIL_PATTERN.match(value):
            raise ValueError("contact_email is not a valid email address")
        return value

    @model_validator(mode="after")
    def _payment_token_required_for_card(self):
        if self.payment_method == "card" and not self.payment_token:
            raise ValueError("payment_token is required when payment_method is 'card'")
        return self


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

    # Optional here even though OrderCreate requires them for new checkouts:
    # orders placed before this field existed have no such attribute in
    # DynamoDB (it's schemaless — nothing backfilled the old rows), and this
    # is the RESPONSE model. A required field here would 500 on every
    # endpoint that reads one of those pre-existing orders back out —
    # confirmed live against the deployed orders table, not hypothetical.
    shipping_address: Optional[ShippingAddress] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    payment_method: Optional[PaymentMethod] = None

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

    # Only meaningful once the saga has actually confirmed the order
    # (CONFIRMED or PENDING_ON_DELIVERY) — there is nothing to ship for a
    # REJECTED or FAILED order. None until an admin sets it.
    delivery_status: Optional[DeliveryStatus] = None

    # NOTE (see below): saga_status is NOT on this model. It is a storage-level
    # attribute that exists only to drive the sparse saga-status GSI, and
    # it is REMOVEd when an order reaches a healthy terminal state. It is
    # an index key, not part of the API contract, so it is not exposed to
    # clients — status already tells them everything they need.


class OrderPage(BaseModel):
    """The shape returned by the paginated list endpoint, mirroring ProductPage."""
    items: list[Order]
    next_cursor: Optional[str] = None


class OrderSummary(BaseModel):
    """The admin dashboard's analytics panel — aggregated, not a list of
    orders, so there is no pagination shape to mirror here."""
    total_orders: int
    total_revenue: str
    average_order_value: str
    by_status: dict[str, int]
    by_payment_method: dict[str, int]


class DeliveryStatusUpdate(BaseModel):
    delivery_status: DeliveryStatus
