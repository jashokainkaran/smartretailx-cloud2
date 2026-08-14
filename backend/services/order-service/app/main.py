import base64
import json
import logging

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from app import config, repository, saga
from app.clients import DownstreamUnknown
from app.models import Order, OrderCreate, OrderPage
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
def create_order(request: OrderCreate):
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
        return saga.run_checkout(request)
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
def list_stuck_orders():
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


@app.get("/api/v1/orders/{order_id}", response_model=Order)
def get_order(order_id: str):
    """Fetch a single order by id."""
    order = repository.get_order(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


@app.get("/api/v1/orders", response_model=OrderPage)
def list_orders(
    customer_id: str,
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
):
    """
    A customer's orders, newest first, with cursor pagination.

    customer_id is required rather than optional: there is no "list every
    order in the system" endpoint, because that would be a full table Scan
    and, once auth exists, a data-protection problem. Same cursor scheme as
    the Product service — an opaque base64 encoding of DynamoDB's
    LastEvaluatedKey, not an offset, because DynamoDB has no offset and
    emulating one costs more the deeper you page.
    """
    start_key = None
    if cursor:
        try:
            start_key = json.loads(base64.urlsafe_b64decode(cursor).decode())
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid cursor")

    items, last_key = repository.list_orders_by_customer(
        customer_id=customer_id, limit=limit, cursor=start_key
    )

    next_cursor = None
    if last_key:
        next_cursor = base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()

    return {"items": items, "next_cursor": next_cursor}


# Same Mangum wrapper as every other service: identical code runs under
# uvicorn locally and as a Lambda in AWS (ADR-005).
handler = Mangum(app)
