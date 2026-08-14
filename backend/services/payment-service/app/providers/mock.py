import uuid
from decimal import Decimal

from app.providers.base import ChargeResult, PaymentProvider


class MockPaymentProvider(PaymentProvider):
    """
    Stand-in PSP for local development and tests. No network calls, no
    real money.

    Failure is deterministic rather than random, so the saga's compensation
    path can be demonstrated and tested reliably: any payment_token
    containing "decline" (e.g. "tok_test_decline") is declined; everything
    else succeeds. This mirrors how real PSPs work — Stripe and others
    publish test tokens that always decline — and keeps the trigger in the
    payment instrument rather than the amount, since .99 is the most
    common retail price ending and a trigger on that would decline most
    realistic prices.
    """

    def charge(self, amount: Decimal, payment_token: str,
               idempotency_key: str) -> ChargeResult:
        # idempotency_key is accepted but unused — a real PSP uses it to
        # deduplicate retried requests over an unreliable network; the mock
        # is stateless. It's in the signature so a real provider needs no
        # interface change.
        if "decline" in payment_token:
            return ChargeResult(False, None, "Card declined by issuer")
        return ChargeResult(True, f"txn_{uuid.uuid4().hex}")

    def refund(self, transaction_reference: str,
               idempotency_key: str) -> bool:
        return True
