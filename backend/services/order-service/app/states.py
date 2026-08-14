"""
Order saga states (ADR-033, as amended).

Named as verbs in the progressive tense — RESERVING_STOCK, not
STOCK_RESERVED — because ADR-033 requires each state to be written BEFORE
the corresponding call is made. A record saying STOCK_RESERVED written
before the reserve has happened asserts something that may not be true;
RESERVING_STOCK asserts only what the saga was attempting, which is
exactly what recovery needs to know.

The semantics are unchanged from ADR-033: intent is recorded before the
action, so the worst case is a record claiming something that may not have
happened — which is checkable against the participant. An unrecorded
action is invisible; an unperformed record is verifiable.
"""

# --- In flight -------------------------------------------------------------
# The saga is running (or died) somewhere in here. Every one of these means
# "may or may not have completed" and must be verified against the
# participant, never assumed.
PENDING = "PENDING"                      # order written, nothing attempted yet
RESERVING_STOCK = "RESERVING_STOCK"      # about to call Inventory reserve
TAKING_PAYMENT = "TAKING_PAYMENT"        # about to call Payment charge
CONFIRMING_STOCK = "CONFIRMING_STOCK"    # about to call Inventory confirm

IN_FLIGHT = {PENDING, RESERVING_STOCK, TAKING_PAYMENT, CONFIRMING_STOCK}

# --- Terminal, healthy -----------------------------------------------------
CONFIRMED = "CONFIRMED"    # paid and stock confirmed; the happy path
REJECTED = "REJECTED"      # insufficient stock; nothing was taken, nothing to undo
FAILED = "FAILED"          # something failed AND compensation succeeded

# --- Terminal, needs a human ----------------------------------------------
# PAYMENT_UNKNOWN is an amendment to ADR-033, which listed only four
# terminal states. ADR-034 says an UNKNOWN payment cannot be treated as
# FAILED, because the card may actually have been charged — so the saga
# must NOT release the stock and must NOT refund. But it has nowhere to
# land: it is not FAILED (we don't know that), and it is not
# COMPENSATION_FAILED (no compensation was ever attempted). Hence a fifth
# state. Both of these are alarmed (ADR-035).
PAYMENT_UNKNOWN = "PAYMENT_UNKNOWN"
COMPENSATION_FAILED = "COMPENSATION_FAILED"

TERMINAL = {CONFIRMED, REJECTED, FAILED, PAYMENT_UNKNOWN, COMPENSATION_FAILED}

# States that stay visible in the sparse saga-status GSI after the saga has
# stopped running. Everything else has its saga_status attribute REMOVEd on
# reaching a terminal state, which drops it out of the index entirely — the
# same trick the outbox uses (ADR-020). The index therefore contains
# exactly two things: orders still in flight, and orders a human must fix.
NEEDS_ATTENTION = {PAYMENT_UNKNOWN, COMPENSATION_FAILED}
