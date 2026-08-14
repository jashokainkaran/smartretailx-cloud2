from abc import ABC, abstractmethod
from decimal import Decimal
from typing import Optional


class ChargeResult:
    def __init__(self, succeeded: bool, transaction_reference: Optional[str],
                 failure_reason: Optional[str] = None):
        self.succeeded = succeeded
        self.transaction_reference = transaction_reference
        self.failure_reason = failure_reason


class PaymentProvider(ABC):
    """
    The boundary between SmartRetailX and a payment service provider.

    Card data never crosses this boundary inward. The provider is given a
    token obtained from its own hosted fields and returns a transaction
    reference. This makes the PCI-DSS scope reduction of ADR-007 structural
    rather than procedural: card data is handled entirely by the provider,
    outside our systems, so this service cannot store, log, or leak it.
    """

    @abstractmethod
    def charge(self, amount: Decimal, payment_token: str,
               idempotency_key: str) -> ChargeResult:
        ...

    @abstractmethod
    def refund(self, transaction_reference: str,
               idempotency_key: str) -> bool:
        ...
