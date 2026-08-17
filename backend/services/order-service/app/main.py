import base64
import json
import logging

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from app import config, repository, saga
from app.auth import claims_from_request, groups, require_admin, require_customer
from app.clients import DownstreamUnknown
from app.models import DeliveryStatusUpdate, Order, OrderCreate, OrderPage
from app.saga import BasketInvalid

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)

app = FastAPI(
    title="SmartRetailX - Order Service",
    version="1.0.0",
    description="Order service and orchestrated checkout saga (ADR-028)",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/api/v1/orders", response_model=Order, status_code=201)
def create_order(order_request: OrderCreate, claims: dict = Depends(require_customer)):
    """
    Run the checkout saga and return the order in its terminal state.

    Always 201 when an order record was created, whatever the outcome —
    including REJECTED and the states requiring reconciliation. The order
    exists, it is addressable, and its `status` field carries the result.
    Returning 4xx for a rejected order would imply the request was bad; it
    was not, the stock simply ran out, and the customer has an order record
    explaining exactly that.

    The two failures that produce no order at all are the ones where
    nothing happened anywhere: an unpriceable basket, and a catalogue we
    could not reach.
    """
    try:
        # A browser must never select another person's customer_id. Cognito's
        # immutable subject is the ownership key, so the submitted value is
        # intentionally replaced before the saga creates any record.
        trusted_customer_id = order_request.customer_id if config.AUTH_TEST_MODE else claims["sub"]
        trusted_request = order_request.model_copy(update={"customer_id": trusted_customer_id})
        return saga.run_checkout(trusted_request)
    except BasketInvalid as exc:
        # 409 rather than 400: the request was well-formed, but the world
        # changed underneath it — the product was withdrawn or removed
        # between browsing and checkout.
        raise HTTPException(status_code=409, detail=str(exc))
    except DownstreamUnknown as exc:
        # Only reachable from the pricing call, before any order exists.
        # Nothing was written and nothing was attempted, so the client can
        # safely retry the whole request.
        raise HTTPException(
            status_code=503, detail=f"Catalogue unavailable, please retry: {exc}"
        )


# Declared BEFORE /api/v1/orders/{order_id}. FastAPI matches routes in
# declaration order, so the parameterised route would otherwise swallow
# "stuck" as an order id and return 404.
@app.get("/api/v1/orders/stuck", response_model=list[Order])
def list_stuck_orders(_claims: dict = Depends(require_admin)):
    """
    Every order requiring human reconciliation: PAYMENT_UNKNOWN,
    STOCK_UNKNOWN and COMPENSATION_FAILED.

    Served from the sparse saga-status GSI. Healthy finished orders have
    had their saga_status attribute removed and are not in the index at
    all, so this query reads only what is actually broken rather than
    filtering the whole table.

    Admin-only once Cognito is in place.
    """
    return repository.list_orders_needing_attention()


# Declared BEFORE /api/v1/orders/{order_id} for the same reason as /stuck
# above — otherwise the parameterised route would swallow "admin" as an
# order id.
@app.get("/api/v1/orders/admin", response_model=OrderPage)
def list_all_orders_admin(
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
    _claims: dict = Depends(require_admin),
):
    """
    Every order, across every customer — the admin Customers & Orders view.

    The customer-scoped GET /api/v1/orders below deliberately has no "list
    everyone's orders" option, for the data-protection reason its own
    docstring gives. This is that capability, made safe the same way
    /orders/stuck is: gated to admin only, not exposed on the general
    endpoint. repository.list_all_orders() is a Scan (see its own docstring
    for why there is no GSI that avoids one) — fine at this project's data
    volume, a genuine scaling limitation at real volume.
    """
    start_key = None
    if cursor:
        try:
            start_key = json.loads(base64.urlsafe_b64decode(cursor).decode())
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid cursor")

    items, last_key = repository.list_all_orders(limit=limit, cursor=start_key)

    next_cursor = None
    if last_key:
        next_cursor = base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()

    return {"items": items, "next_cursor": next_cursor}


@app.get("/api/v1/orders/{order_id}", response_model=Order)
def get_order(order_id: str, claims: dict = Depends(claims_from_request)):
    """Fetch a single order by id."""
    order = repository.get_order(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    if "admin" not in groups(claims) and order["customer_id"] != claims["sub"]:
        # Return 404 rather than confirming that another customer's order ID
        # exists. This limits order-ID probing as well as denying the read.
        raise HTTPException(status_code=404, detail="Order not found")
    return order


@app.patch("/api/v1/orders/{order_id}/delivery-status", response_model=Order)
def update_delivery_status(
    order_id: str,
    body: DeliveryStatusUpdate,
    _claims: dict = Depends(require_admin),
):
    """
    Set fulfilment progress on a confirmed order (admin-only).

    Not a saga transition — repository.set_delivery_status() only requires
    the order to currently be CONFIRMED or PENDING_ON_DELIVERY, and does not
    itself validate a forward-only sequence (PROCESSING -> ... -> DELIVERED).
    That is a deliberate simplicity trade-off: this is operational
    bookkeeping an admin corrects by hand, not a financial safety property
    like the saga's own conditional transitions.
    """
    if repository.get_order(order_id) is None:
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        return repository.set_delivery_status(order_id, body.delivery_status)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/api/v1/orders", response_model=OrderPage)
def list_orders(
    customer_id: str | None = None,
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
    claims: dict = Depends(require_customer),
):
    """
    The signed-in customer's orders, newest first, with cursor pagination.

    The customer key is Cognito's subject claim, not a request query value —
    this endpoint cannot be used to browse another customer's orders, even
    by an admin (see GET /api/v1/orders/admin below for that capability,
    gated separately). Same cursor scheme as the Product service — an opaque
    base64 encoding of DynamoDB's LastEvaluatedKey, not an offset, because
    DynamoDB has no offset and emulating one costs more the deeper you page.
    """
    start_key = None
    if cursor:
        try:
            start_key = json.loads(base64.urlsafe_b64decode(cursor).decode())
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid cursor")

    effective_customer_id = customer_id if config.AUTH_TEST_MODE and customer_id else claims["sub"]
    items, last_key = repository.list_orders_by_customer(
        customer_id=effective_customer_id, limit=limit, cursor=start_key
    )

    next_cursor = None
    if last_key:
        next_cursor = base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()

    return {"items": items, "next_cursor": next_cursor}


# Same Mangum wrapper as every other service: identical code runs under
# uvicorn locally and as a Lambda in AWS (ADR-005).
handler = Mangum(app)
