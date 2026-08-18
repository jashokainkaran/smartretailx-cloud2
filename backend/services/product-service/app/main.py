from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from botocore.exceptions import BotoCoreError, ClientError
from mangum import Mangum
from app.models import (
    ProductCreate,
    Product,
    ProductPage,
    ProductUpdate,
    ProductBatchRequest,
)
from app import repository
from app.auth import require_admin
from app.correlation import correlation_id_from_request, correlation_middleware
from fastapi.middleware.cors import CORSMiddleware
from app import config
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="SmartRetailX - Product Catalogue Service",
    version="1.0.0",
    description="Product catalogue service with pagination support"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,   # only OUR frontend, not "*"
    allow_credentials=True,
    allow_methods=["*"],                 # GET, POST, etc.
    allow_headers=["*"],
    expose_headers=["X-Correlation-ID"],
)

app.middleware("http")(correlation_middleware)


@app.get("/health")
def health(request: Request):
    """Report healthy only when the product table is reachable."""
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


@app.post("/api/v1/products", response_model=Product, status_code=201)
def create_product(product: ProductCreate, _claims: dict = Depends(require_admin)):
    """Create a new product."""
    return repository.create_product(product)


@app.post("/api/v1/products/batch", response_model=list[Product])
def batch_get_products(request: ProductBatchRequest):
    """
    Fetch many products by id in one request.

    Used by the Order saga to resolve prices server-side: the client never
    sends a price, so every basket line must be priced from the catalogue
    before the order total can be computed.

    This is a read, but it is a POST rather than a GET. A GET would have to
    carry the ids in the query string, which runs into URL length limits and
    proxy truncation on a large basket, and would put customer basket
    contents into access logs. The request body is the right place for a
    variable-length list. The trade-off is that this endpoint is not
    cacheable by HTTP intermediaries, which does not matter here — prices
    must be current at the moment of sale.

    Products that do not exist are simply absent from the response. The
    caller compares what it asked for against what it received; the
    catalogue does not decide what a missing product means.

    Deactivated products ARE returned, carrying active: false (ADR-037).
    Filtering them here would make "missing" and "withdrawn" indistinguishable
    to the caller, and the saga needs to tell a customer which of the two
    happened.
    """
    return repository.batch_get_products(request.product_ids)


@app.get("/api/v1/products/admin", response_model=ProductPage)
def list_products_for_admin(
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
    _claims: dict = Depends(require_admin),
):
    """List active and inactive products for the administrator workspace."""
    items, next_cursor = repository.list_products(
        limit=limit, cursor=cursor, include_inactive=True
    )
    return {"items": items, "next_cursor": next_cursor}


@app.get("/api/v1/products/{product_id}", response_model=Product)
def get_product(product_id: str):
    """Fetch a single product by id."""
    product = repository.get_product(product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


@app.put("/api/v1/products/{product_id}", response_model=Product)
def update_product(product_id: str, product: ProductUpdate, _claims: dict = Depends(require_admin)):
    """
    Partially update a product. Only the fields supplied in the body are
    changed; omitted fields are left untouched.
    """
    updated = repository.update_product(product_id, product)
    if updated is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return updated


@app.patch("/api/v1/products/{product_id}/deactivate", response_model=Product)
def deactivate_product(product_id: str, _claims: dict = Depends(require_admin)):
    """Deactivate a product so it no longer appears in the default listing."""
    updated = repository.set_product_active(product_id, False)
    if updated is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return updated


@app.patch("/api/v1/products/{product_id}/activate", response_model=Product)
def activate_product(product_id: str, _claims: dict = Depends(require_admin)):
    """Reactivate a previously deactivated product."""
    updated = repository.set_product_active(product_id, True)
    if updated is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return updated


@app.get("/api/v1/products", response_model=ProductPage)
def list_products(
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
):
    """
    Fetch active products with cursor-based pagination. Public browsing only —
    deactivated products are never returned here. The admin catalogue view,
    which needs both, is GET /api/v1/products/admin instead: a public route
    cannot also carry an admin-only query parameter, because API Gateway's
    JWT authorizer is attached per ROUTE, not per query string, so an
    in-app-only check on this route can never actually see real claims
    (nothing here attaches the authorizer to make API Gateway populate them).

    Parameters:
    - limit: Number of items to return (1-100, default: 20)
    - cursor: Pagination cursor for the next page

    Returns:
    - items: List of Product objects
    - next_cursor: Cursor for the next page (null if no more pages)
    """
    items, next_cursor = repository.list_products(
        limit=limit, cursor=cursor, include_inactive=False
    )
    return {"items": items, "next_cursor": next_cursor}

handler = Mangum(app)
