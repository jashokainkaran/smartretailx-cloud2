from decimal import Decimal
from pydantic import BaseModel, Field
from typing import Optional


class PaymentRequest(BaseModel):
    order_id: str
    amount: Decimal = Field(..., gt=0, decimal_places=2)
    payment_token: str      # PSP token — never a card number (ADR-007)


class Payment(BaseModel):
    payment_id: str
    order_id: str
    amount: Decimal
    status: str              # SUCCEEDED | FAILED | REFUNDED
    transaction_reference: Optional[str] = None
    failure_reason: Optional[str] = None
    created_at: str
    refunded_at: Optional[str] = None
    already_refunded: Optional[bool] = None
