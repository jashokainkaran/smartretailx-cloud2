"""
Request correlation for SmartRetailX.

A correlation ID is a random UUID for one request journey. It is not a
customer ID and contains no personal data. Each concurrent request has its
own ID, so logs from many customers do not become mixed together.
"""

import logging
import time
from contextvars import ContextVar
from uuid import UUID, uuid4

from fastapi import Request

CORRELATION_HEADER = "X-Correlation-ID"

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# ContextVar is request-local: concurrent customers never share this value.
# It is the safe alternative to a process-wide global variable in Lambda.
_current_correlation_id: ContextVar[str | None] = ContextVar(
    "current_correlation_id", default=None
)


def get_or_create_correlation_id(raw_value: str | None) -> str:
    """
    Keep a caller-supplied correlation ID only when it is a valid UUID.

    Rejecting arbitrary text prevents an attacker from injecting misleading
    content into application logs through an HTTP header.
    """
    if raw_value:
        try:
            UUID(raw_value)
            return raw_value
        except (ValueError, AttributeError):
            pass

    return str(uuid4())


async def correlation_middleware(request: Request, call_next):
    """
    Attach one correlation ID to this request, its response, and its logs.
    """
    correlation_id = get_or_create_correlation_id(
        request.headers.get(CORRELATION_HEADER)
    )
    request.state.correlation_id = correlation_id
    context_token = _current_correlation_id.set(correlation_id)

    started_at = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception:
        logger.exception(
            "request_failed correlation_id=%s method=%s path=%s",
            correlation_id,
            request.method,
            request.url.path,
        )
        raise
    else:
        duration_ms = round((time.perf_counter() - started_at) * 1000, 2)

        response.headers[CORRELATION_HEADER] = correlation_id

        logger.info(
            "request_completed correlation_id=%s method=%s path=%s status=%s duration_ms=%s",
            correlation_id,
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )

        return response
    finally:
        _current_correlation_id.reset(context_token)


def correlation_id_from_request(request: Request) -> str:
    """
    Read the ID previously stored by correlation_middleware.

    This fallback only protects local/unit-test calls that bypass middleware.
    A real deployed request always receives an ID from the middleware.
    """
    return getattr(request.state, "correlation_id", str(uuid4()))


def current_correlation_id() -> str | None:
    """Return the correlation ID for the request currently being handled."""
    return _current_correlation_id.get()
