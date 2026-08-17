"""
HTTP clients for the services the saga orchestrates (ADR-028).

The only genuinely important thing in this file is the distinction between
two kinds of failure, because every branch of the saga turns on it:

  DownstreamRejected — the service answered, and the answer was no.
      We know what happened. Nothing ambiguous. Insufficient stock, a
      declined card, a validation error. The saga can act with confidence.

  DownstreamUnknown  — we got no usable answer at all.
      A timeout, a dropped connection, a 500. The operation may have
      completed perfectly and lost the reply, or never have happened. We
      cannot tell, and in most cases we cannot find out afterwards.

Collapsing these two into one "it failed" is the single most dangerous
simplification available in a saga, because the correct response to each is
the opposite of the other: a rejection should be compensated, an unknown
must NOT be, since compensating something that never happened causes the
damage you were trying to avoid.

The mapping:
    2xx        -> success
    4xx        -> DownstreamRejected  (the service made a decision)
    5xx        -> DownstreamUnknown   (the service broke mid-request)
    timeout    -> DownstreamUnknown
    no connect -> DownstreamUnknown

A 4xx is safe to treat as definite because it means the request reached the
service, was understood, and was refused — all of our downstream 4xx
responses come from conditional writes that either applied or did not.
"""

import logging
from decimal import Decimal

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from app import config

logger = logging.getLogger(__name__)


class DownstreamRejected(Exception):
    """The service answered and refused. The outcome is known."""

    def __init__(self, status_code: int, detail, body=None):
        self.status_code = status_code
        self.detail = detail
        self.body = body
        super().__init__(f"{status_code}: {detail}")


class DownstreamUnknown(Exception):
    """No usable answer. The operation may or may not have happened."""


def _parse(response):
    try:
        return response.json()
    except ValueError:
        return None


def _detail(body, response):
    if isinstance(body, dict) and "detail" in body:
        return body["detail"]
    return response.text


def _signed_request(request: httpx.Request) -> httpx.Response:
    """Send an API Gateway request signed by this Lambda's IAM role."""
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise DownstreamUnknown("no AWS credentials available for internal API call")

    frozen_credentials = credentials.get_frozen_credentials()
    aws_request = AWSRequest(
        method=request.method,
        url=str(request.url),
        data=request.content,
        headers=dict(request.headers),
    )
    SigV4Auth(frozen_credentials, "execute-api", config.AWS_REGION).add_auth(aws_request)

    # httpx sends the exact signed body and headers. The Order role is limited
    # in Terraform to just these internal API operations.
    signed_headers = dict(aws_request.headers.items())
    with httpx.Client(timeout=config.DOWNSTREAM_TIMEOUT_SECONDS) as client:
        return client.send(
            httpx.Request(
                method=request.method,
                url=str(request.url),
                headers=signed_headers,
                content=request.content,
            )
        )


def _request(method: str, url: str, **kwargs):
    try:
        request = httpx.Request(method, url, **kwargs)
        if config.SIGN_DOWNSTREAM_REQUESTS:
            response = _signed_request(request)
        else:
            response = httpx.request(
                method,
                url,
                timeout=config.DOWNSTREAM_TIMEOUT_SECONDS,
                **kwargs,
            )
    except httpx.RequestError as exc:
        # Covers timeouts, DNS failures, refused and dropped connections.
        # We never saw a status line, so we know nothing about the outcome.
        logger.warning("downstream unreachable url=%s error=%s", url, exc)
        raise DownstreamUnknown(f"no response from {url}: {exc}") from exc

    if response.status_code >= 500:
        # The service accepted the request and then broke. Whether it
        # completed the work first is exactly what we cannot determine.
        logger.warning("downstream 5xx url=%s status=%s", url, response.status_code)
        raise DownstreamUnknown(f"{url} returned {response.status_code}")

    if response.status_code >= 400:
        body = _parse(response)
        raise DownstreamRejected(response.status_code, _detail(body, response), body)

    return response


# --- Product Catalogue -----------------------------------------------------

def fetch_products(product_ids: list[str]) -> dict:
    """
    Resolve every basket line against the catalogue in ONE round trip.

    Returns {product_id: product_dict}. Products that do not exist are
    simply absent — the caller decides what that means.
    """
    response = _request(
        "POST",
        f"{config.PRODUCT_SERVICE_URL}/api/v1/products/batch",
        json={"product_ids": product_ids},
    )
    return {product["id"]: product for product in response.json()}


# --- Inventory -------------------------------------------------------------

def _stock_payload(line_items) -> list[dict]:
    return [
        {"product_id": item.product_id, "quantity": item.quantity}
        for item in line_items
    ]


def reserve_stock(line_items):
    """All-or-nothing reserve. 409 means at least one line is short."""
    _request(
        "POST",
        f"{config.INVENTORY_SERVICE_URL}/api/v1/inventory/reserve",
        json=_stock_payload(line_items),
    )


def release_stock(line_items):
    """Compensating action for a reserve that must be undone."""
    _request(
        "POST",
        f"{config.INVENTORY_SERVICE_URL}/api/v1/inventory/release",
        json=_stock_payload(line_items),
    )


def confirm_stock(line_items):
    """The goods are paid for and leave inventory permanently."""
    _request(
        "POST",
        f"{config.INVENTORY_SERVICE_URL}/api/v1/inventory/confirm",
        json=_stock_payload(line_items),
    )


# --- Payment ---------------------------------------------------------------

def charge_payment(order_id: str, amount: Decimal, payment_token: str) -> dict:
    """
    Charge the customer.

    amount is sent as a STRING, not a JSON number (ADR-039). A JSON number
    is parsed to a float before Pydantic can build a Decimal, which silently
    reintroduces binary floating-point error into a monetary value.

    A 402 arrives here as DownstreamRejected carrying the full Payment
    record in .body — the Payment service deliberately returns the record
    rather than an error envelope on a decline, so the saga can read
    payment_id and failure_reason from a refusal.
    """
    response = _request(
        "POST",
        f"{config.PAYMENT_SERVICE_URL}/api/v1/payments",
        json={
            "order_id": order_id,
            "amount": str(amount),
            "payment_token": payment_token,
        },
    )
    return response.json()


def refund_payment(payment_id: str) -> dict:
    """
    Compensating action for a charge that must be undone.

    Idempotent on the Payment service's side: a repeated refund returns 200
    with the original refunded_at and already_refunded=True, so a retry
    here cannot double-refund.
    """
    response = _request(
        "POST",
        f"{config.PAYMENT_SERVICE_URL}/api/v1/payments/{payment_id}/refund",
    )
    return response.json()
