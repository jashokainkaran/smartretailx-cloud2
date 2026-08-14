from fastapi import FastAPI, HTTPException, Query
from mangum import Mangum
from app.models import ProductCreate, Product, ProductPage, ProductUpdate
from app import repository
from fastapi.middleware.cors import CORSMiddleware
from app import config
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
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
)


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/api/v1/products", response_model=Product, status_code=201)
def create_product(product: ProductCreate):
    """Create a new product."""
    return repository.create_product(product)


@app.get("/api/v1/products/{product_id}", response_model=Product)
def get_product(product_id: str):
    """Fetch a single product by id."""
    product = repository.get_product(product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


@app.put("/api/v1/products/{product_id}", response_model=Product)
def update_product(product_id: str, product: ProductUpdate):
    """
    Partially update a product. Only the fields supplied in the body are
    changed; omitted fields are left untouched.
    """
    updated = repository.update_product(product_id, product)
    if updated is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return updated


@app.patch("/api/v1/products/{product_id}/deactivate", response_model=Product)
def deactivate_product(product_id: str):
    """Deactivate a product so it no longer appears in the default listing."""
    updated = repository.set_product_active(product_id, False)
    if updated is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return updated


@app.patch("/api/v1/products/{product_id}/activate", response_model=Product)
def activate_product(product_id: str):
    """Reactivate a previously deactivated product."""
    updated = repository.set_product_active(product_id, True)
    if updated is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return updated


@app.get("/api/v1/products", response_model=ProductPage)
def list_products(
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
    include_inactive: bool = False,
):
    """
    Fetch products with cursor-based pagination.

    Parameters:
    - limit: Number of items to return (1-100, default: 20)
    - cursor: Pagination cursor for the next page
    - include_inactive: Include deactivated products (default: false).
      Customers see only active products; the admin UI passes true.

    Returns:
    - items: List of Product objects
    - next_cursor: Cursor for the next page (null if no more pages)
    """
    items, next_cursor = repository.list_products(
        limit=limit, cursor=cursor, include_inactive=include_inactive
    )
    return {"items": items, "next_cursor": next_cursor}

handler = Mangum(app)