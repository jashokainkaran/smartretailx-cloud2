from fastapi import FastAPI, HTTPException, Query
from mangum import Mangum
from app.models import ProductCreate, Product
from app import repository
from fastapi.middleware.cors import CORSMiddleware
from app import config

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


@app.get("/api/v1/products", response_model=dict)
def list_products(
    limit: int = Query(default=20, le=100, ge=1),
    cursor: str | None = None,
):
    """
    Fetch products with cursor-based pagination.

    Parameters:
    - limit: Number of items to return (1-100, default: 20)
    - cursor: Pagination cursor for the next page

    Returns:
    - items: List of Product objects
    - next_cursor: Cursor for the next page (null if no more pages)
    """
    items, next_cursor = repository.list_products(limit=limit, cursor=cursor)
    return {
        "items": items,
        "next_cursor": next_cursor,
    }


handler = Mangum(app)