from app import config
from app.providers.mock import MockPaymentProvider


def get_provider():
    """
    Return the configured PaymentProvider implementation.

    Adding a real PSP means implementing a new provider class against
    PaymentProvider (app/providers/base.py) and adding one branch here —
    no other file changes.
    """
    if config.PAYMENT_PROVIDER == "mock":
        return MockPaymentProvider()
    raise ValueError(f"Unknown payment provider: {config.PAYMENT_PROVIDER}")
