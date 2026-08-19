"""Regression coverage for the saga's downstream circuit breaker.

Pure logic tests — no DynamoDB, no HTTP. Still needs the same env-var header
as test_auth.py: importing app.circuit_breaker pulls in app.clients, which
pulls in app.config, and config.py reads its table names once at import
time. Pytest collects files alphabetically, and this file sorts before
test_orders.py, so it must set the same variables or it freezes app.config
against the real (unset) environment before test_orders.py's own
assignments ever run — the exact CP-047 fragility already documented there.
"""
import os

os.environ["ORDERS_TABLE"] = "OrdersTest"
os.environ["ORDER_OUTBOX_TABLE"] = "OrderOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

import pytest

from app import circuit_breaker, config
from app.circuit_breaker import CircuitOpenError, guarded
from app.clients import DownstreamRejected, DownstreamUnknown


@pytest.fixture(autouse=True)
def clean_breakers():
    circuit_breaker.reset_all()
    yield
    circuit_breaker.reset_all()


class FakeClock:
    """Deterministic stand-in for time.monotonic() — no real sleeping."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def test_a_successful_call_passes_through_and_returns_the_result():
    assert guarded("inventory", lambda: "ok") == "ok"


def test_downstream_rejected_never_trips_the_circuit():
    def reject():
        raise DownstreamRejected(409, "insufficient stock")

    # Well past the failure threshold, all rejections — the circuit must
    # stay closed throughout, since a rejection means the service is up.
    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD + 5):
        with pytest.raises(DownstreamRejected):
            guarded("inventory", reject)

    # Still closed: a normal call goes straight through, no CircuitOpenError.
    assert guarded("inventory", lambda: "still healthy") == "still healthy"


def test_the_threshold_number_of_consecutive_unknowns_trips_the_circuit():
    def unknown():
        raise DownstreamUnknown("timeout")

    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1):
        with pytest.raises(DownstreamUnknown):
            guarded("payment", unknown)

    breaker = circuit_breaker._breaker_for("payment")
    assert breaker.state == "CLOSED"  # one short of the threshold

    with pytest.raises(DownstreamUnknown):
        guarded("payment", unknown)

    assert breaker.state == "OPEN"


def test_an_open_circuit_skips_the_call_entirely():
    calls = []

    def unknown():
        calls.append(1)
        raise DownstreamUnknown("timeout")

    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD):
        with pytest.raises(DownstreamUnknown):
            guarded("inventory", unknown)
    assert len(calls) == config.CIRCUIT_BREAKER_FAILURE_THRESHOLD

    with pytest.raises(CircuitOpenError):
        guarded("inventory", unknown)

    # The underlying function was never invoked the fourth time — the whole
    # point of failing fast.
    assert len(calls) == config.CIRCUIT_BREAKER_FAILURE_THRESHOLD


def test_circuit_open_error_is_not_a_downstream_unknown():
    # Corrected design: a skipped call is a CERTAIN outcome (nothing was
    # sent, so nothing could have happened), not an uncertain one. An
    # earlier version made CircuitOpenError a DownstreamUnknown subclass so
    # every saga branch would handle it "for free" — that was wrong, because
    # it made the saga treat "definitely didn't happen" the same as "might
    # have happened," stranding stock/payment state unnecessarily. saga.py
    # now catches CircuitOpenError explicitly at each forward-path call site
    # instead of relying on inheritance to route it into the uncertain-
    # outcome branches.
    assert not issubclass(CircuitOpenError, DownstreamUnknown)
    assert issubclass(CircuitOpenError, Exception)


def test_after_the_reset_timeout_one_trial_call_is_allowed(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(circuit_breaker.time, "monotonic", clock)

    def unknown():
        raise DownstreamUnknown("timeout")

    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD):
        with pytest.raises(DownstreamUnknown):
            guarded("inventory", unknown)

    # Still inside the reset window — stays fast-failed.
    with pytest.raises(CircuitOpenError):
        guarded("inventory", unknown)

    clock.advance(config.CIRCUIT_BREAKER_RESET_TIMEOUT_SECONDS)

    # Past the window: the next call is a real trial, not a skip.
    calls = []

    def succeed():
        calls.append(1)
        return "recovered"

    assert guarded("inventory", succeed) == "recovered"
    assert calls == [1]


def test_a_successful_trial_call_closes_the_circuit(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(circuit_breaker.time, "monotonic", clock)

    def unknown():
        raise DownstreamUnknown("timeout")

    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD):
        with pytest.raises(DownstreamUnknown):
            guarded("payment", unknown)

    clock.advance(config.CIRCUIT_BREAKER_RESET_TIMEOUT_SECONDS)
    guarded("payment", lambda: "ok")

    breaker = circuit_breaker._breaker_for("payment")
    assert breaker.state == "CLOSED"
    assert breaker.consecutive_failures == 0


def test_a_failed_trial_call_reopens_the_circuit_immediately(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(circuit_breaker.time, "monotonic", clock)

    def unknown():
        raise DownstreamUnknown("timeout")

    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD):
        with pytest.raises(DownstreamUnknown):
            guarded("payment", unknown)

    clock.advance(config.CIRCUIT_BREAKER_RESET_TIMEOUT_SECONDS)

    # The trial call itself fails again — should reopen on this ONE
    # failure, not require hitting the full threshold a second time.
    with pytest.raises(DownstreamUnknown):
        guarded("payment", unknown)

    breaker = circuit_breaker._breaker_for("payment")
    assert breaker.state == "OPEN"

    with pytest.raises(CircuitOpenError):
        guarded("payment", unknown)


def test_breakers_are_independent_per_service():
    def unknown():
        raise DownstreamUnknown("timeout")

    for _ in range(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD):
        with pytest.raises(DownstreamUnknown):
            guarded("inventory", unknown)

    assert circuit_breaker._breaker_for("inventory").state == "OPEN"
    # A completely unrelated service's breaker is untouched.
    assert circuit_breaker._breaker_for("payment").state == "CLOSED"
    assert guarded("payment", lambda: "unaffected") == "unaffected"
