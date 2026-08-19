"""
A small, honestly-scoped circuit breaker for the saga's downstream calls.

Only DownstreamUnknown counts as a health signal. DownstreamRejected means
the service is up and answered correctly — it just said no (declined card,
insufficient stock) — so it closes the breaker rather than tripping it,
exactly the same distinction clients.py's own docstring already draws for
the saga's compensation logic. Repeatedly hammering a downstream that is
timing out or 500-ing wastes DOWNSTREAM_TIMEOUT_SECONDS on every retry and
holds a stock reservation (and, on the payment breaker, an uncharged card)
open for no benefit; the breaker exists to fail fast instead once a service
has shown CIRCUIT_BREAKER_FAILURE_THRESHOLD (config.py, default 3)
DownstreamUnknown results in a row. That threshold and
CIRCUIT_BREAKER_RESET_TIMEOUT_SECONDS (default 30s) are both environment
variables, not constants — the same reasoning DOWNSTREAM_TIMEOUT_SECONDS
already documents in config.py: a tuning knob, not a value to bake into
code. Deliberately NOT time-windowed — three failures spread across an
hour trip it exactly the same as three in two seconds. A time-windowed
version would be more precise but needs tracking failure timestamps, not
just a count; accepted as a known simplification rather than built out
under a tight deadline.

Known, accepted limitation, stated up front rather than discovered later:
Lambda execution environments are not shared between concurrent
invocations. This breaker's state lives in ordinary module-level memory, so
it is scoped to ONE warm container, not the whole deployed service — a cold
start (or a sibling container handling a concurrent request) starts CLOSED
again with no memory of a trip that just happened next door. A shared
breaker (backed by DynamoDB or ElastiCache) would give a stronger,
service-wide guarantee; that extra stateful dependency was judged
disproportionate for this project's scale and left as a known gap rather
than solved silently.
"""

import logging
import time

from app import config
from app.clients import DownstreamRejected, DownstreamUnknown

logger = logging.getLogger(__name__)


class CircuitOpenError(Exception):
    """
    The breaker is open: this call was never sent.

    Deliberately NOT a DownstreamUnknown subclass, on correction — an
    earlier version of this made it one, on the theory that "definitely not
    attempted" could safely be treated the same as "attempted, outcome
    unknown." That reasoning was backwards. DownstreamUnknown exists
    because the saga cannot tell whether a timed-out call actually
    completed on the far side before the response was lost — that
    uncertainty is exactly why a decline is compensated and an unknown is
    not (see clients.py's own docstring). A skipped call has none of that
    uncertainty: nothing was sent, so nothing could possibly have happened.
    Routing it through the same PAYMENT_UNKNOWN/STOCK_UNKNOWN branches as a
    real timeout was strictly worse than necessary — it strands a stock
    reservation and manufactures a reconciliation case for an outcome the
    saga actually knows with certainty. saga.py now catches
    CircuitOpenError explicitly at each forward-path call site and treats
    it the same way it already treats a definite, known outcome at that
    step (no different, in terms of what needs compensating, from a
    DownstreamRejected there) — not the same as genuine uncertainty.
    """


class _Breaker:
    def __init__(self, name: str):
        self.name = name
        self.state = "CLOSED"
        self.consecutive_failures = 0
        self.opened_at = None

    def before_call(self):
        if self.state != "OPEN":
            return
        if time.monotonic() - self.opened_at >= config.CIRCUIT_BREAKER_RESET_TIMEOUT_SECONDS:
            self.state = "HALF_OPEN"
            logger.warning("circuit half-open, allowing one trial call service=%s", self.name)
            return
        raise CircuitOpenError(f"circuit open for {self.name}, call skipped")

    def _close(self):
        if self.state != "CLOSED":
            logger.warning("circuit closed after a healthy response service=%s", self.name)
        self.state = "CLOSED"
        self.consecutive_failures = 0
        self.opened_at = None

    def on_rejected(self):
        # The service answered. It is healthy, even though it said no.
        self._close()

    def on_success(self):
        self._close()

    def on_unknown(self):
        self.consecutive_failures += 1
        if self.state == "HALF_OPEN" or self.consecutive_failures >= config.CIRCUIT_BREAKER_FAILURE_THRESHOLD:
            self.state = "OPEN"
            self.opened_at = time.monotonic()
            logger.warning(
                "circuit opened after %s consecutive unknown outcomes service=%s",
                self.consecutive_failures, self.name,
            )


_breakers: dict[str, _Breaker] = {}


def _breaker_for(service: str) -> _Breaker:
    if service not in _breakers:
        _breakers[service] = _Breaker(service)
    return _breakers[service]


def reset_all():
    """Test-only: clear all breaker state between tests."""
    _breakers.clear()


def guarded(service: str, fn, *args, **kwargs):
    """
    Call fn(*args, **kwargs) through the named service's breaker.

    Raises CircuitOpenError without calling fn at all if that breaker is
    open. Otherwise calls fn, updates the breaker based on the outcome, and
    re-raises whatever fn raised (or returns what fn returned) unchanged.
    """
    breaker = _breaker_for(service)
    breaker.before_call()
    try:
        result = fn(*args, **kwargs)
    except DownstreamRejected:
        breaker.on_rejected()
        raise
    except DownstreamUnknown:
        breaker.on_unknown()
        raise
    else:
        breaker.on_success()
        return result
