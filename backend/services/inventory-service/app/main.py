import logging

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from mangum import Mangum
from app.models import InventoryItem
from app import events, repository
from fastapi.middleware.cors import CORSMiddleware
from app import config
from app.auth import require_admin
from app.correlation import correlation_id_from_request, correlation_middleware
from app.models import StockOperation

logger = logging.getLogger(__name__)

app = FastAPI(
    title="SmartRetailX - Inventory Service",
    version="1.0.0",
    description="Inventory service with stock reservation and oversell prevention"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Correlation-ID"],
)

app.middleware("http")(correlation_middleware)


@app.get("/health")
def health(request: Request):
    """Report healthy only when the inventory table is reachable."""
    try:
        repository.check_health()
    except (BotoCoreError, ClientError) as exc:
        logger.error(
            "health_check_failed correlation_id=%s error=%s",
            correlation_id_from_request(request),
            exc,
        )
        return JSONResponse(status_code=503, content={"status": "unhealthy"})
    return {"status": "healthy"}


@app.get("/api/v1/inventory/{product_id}", response_model=InventoryItem)
def get_stock(product_id: str):
    """Get the current stock level for a product."""
    item = repository.get_stock(product_id)
    if item is None:
        raise HTTPException(status_code=404, detail="No inventory record for this product")
    return item


@app.get("/api/v1/inventory/admin/low-stock", response_model=list[InventoryItem])
def low_stock(
    threshold: int = Query(default=10, ge=0),
    _claims: dict = Depends(require_admin),
):
    """Every product at or below `threshold` available units — the admin
    dashboard's low-stock alert list. A flat, global threshold by design
    (see repository.list_low_stock()'s own docstring for the "something
    smarter" alternatives considered and not built)."""
    return repository.list_low_stock(threshold)


@app.post("/api/v1/inventory/{product_id}/reserve")
def reserve_stock(product_id: str, quantity: int, _claims: dict = Depends(require_admin)):
    """
    Reserve stock for a product. Returns 409 if insufficient stock.

    Not called by the Order saga, which reserves a whole basket at once via
    the all-or-nothing /reserve batch endpoint below. This single-item form
    exists for manual admin stock management (e.g. holding stock for an
    offline sale), so it is admin-only rather than customer- or
    saga-reachable.
    """
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    try:
        result = repository.reserve_stock(product_id, quantity)
    except ValueError as e:
        # Not enough stock — this is the "unavailable" response.
        raise HTTPException(status_code=409, detail=str(e))
    events.publish_stock_changed(product_id)
    return result


@app.post("/api/v1/inventory/{product_id}/release")
def release_stock(product_id: str, quantity: int, _claims: dict = Depends(require_admin)):
    """Release previously reserved stock for a product. Admin-only (see reserve_stock)."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    try:
        result = repository.release_stock(product_id, quantity)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    events.publish_stock_changed(product_id)
    return result

@app.post("/api/v1/inventory/{product_id}/confirm")
def confirm_stock(product_id: str, quantity: int, _claims: dict = Depends(require_admin)):
    """Confirm a sale — permanently remove reserved stock. Admin-only (see reserve_stock)."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    try:
        result = repository.confirm_stock(product_id, quantity)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    events.publish_stock_changed(product_id)
    return result

@app.post("/api/v1/inventory/{product_id}/add")
def add_stock(product_id: str, quantity: int, _claims: dict = Depends(require_admin)):
    """Add stock (restock or create initial record)."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    result = repository.add_stock(product_id, quantity)
    events.publish_stock_changed(product_id)
    return result

MAX_TRANSACTION_ITEMS = 100


def _validate_batch(items: list[StockOperation]):
    """Reject at the boundary rather than letting DynamoDB reject opaquely."""
    if not items:
        raise HTTPException(status_code=400, detail="No items supplied")
    distinct = {i.product_id for i in items}
    if len(distinct) > MAX_TRANSACTION_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"{len(distinct)} distinct products exceeds the "
                   f"{MAX_TRANSACTION_ITEMS}-operation transaction limit",
        )


@app.post("/api/v1/inventory/reserve")
def reserve_batch(items: list[StockOperation]):
    _validate_batch(items)
    try:
        repository.reserve_many(items)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    for product_id in {i.product_id for i in items}:
        events.publish_stock_changed(product_id)
    return {"status": "reserved", "products": len({i.product_id for i in items})}


@app.post("/api/v1/inventory/release")
def release_batch(items: list[StockOperation]):
    _validate_batch(items)
    try:
        repository.release_many(items)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    for product_id in {i.product_id for i in items}:
        events.publish_stock_changed(product_id)
    return {"status": "released", "products": len({i.product_id for i in items})}


@app.post("/api/v1/inventory/confirm")
def confirm_batch(items: list[StockOperation]):
    _validate_batch(items)
    try:
        repository.confirm_many(items)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    for product_id in {i.product_id for i in items}:
        events.publish_stock_changed(product_id)
    return {"status": "confirmed", "products": len({i.product_id for i in items})}

handler = Mangum(app)
