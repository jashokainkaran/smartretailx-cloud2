from decimal import Decimal, ROUND_HALF_UP
from pydantic import BaseModel, Field, field_serializer
from typing import Optional


class PaymentRequest(BaseModel):
    order_id: str
    amount: Decimal = Field(..., gt=0, decimal_places=2)
    payment_token: str      # PSP token — never a card number (ADR-007)


class Payment(BaseModel):
    payment_id: str
    order_id: str
    amount: Decimal
    status: str              # PENDING | SUCCEEDED | FAILED | REFUNDED | UNKNOWN
    # UNKNOWN means the provider was called but the outcome was never
    # observed (e.g. the provider raised instead of returning a result —
    # a timeout after the card was actually charged, for example). The
    # card may or may not have been charged, so the payment requires
    # reconciliation against the PSP before the order can be resolved.
    # This is the same record-intent-before-action principle as the
    # transactional outbox in ADR-020: an unrecorded action is invisible;
    # an action recorded but not completed is checkable.
    transaction_reference: Optional[str] = None
    failure_reason: Optional[str] = None
    created_at: str
    refunded_at: Optional[str] = None
    already_refunded: Optional[bool] = None

    @field_serializer("amount")
    def _serialise_amount(self, value: Decimal) -> str:
        """
        Force two decimal places on the way out.

        DynamoDB discards trailing zeros, so an amount stored as 20.50 reads
        back as 20.5. quantize only pads — 30.89 stays 30.89 — so the value
        is unchanged and only the wire format is stabilised. ROUND_HALF_UP
        is unreachable given decimal_places=2 validation on PaymentRequest,
        but is stated rather than inheriting Python's banker's rounding,
        which rounds 30.885 down where a human expects up.

        Amounts are US dollars (USD); two decimal places is correct for
        cents and assumed system-wide (see ADR-039).
        """
        return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
