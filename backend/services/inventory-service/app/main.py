from fastapi import FastAPI, HTTPException
from mangum import Mangum
from app.models import InventoryItem
from app import repository
from fastapi.middleware.cors import CORSMiddleware
from app import config

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
)


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/api/v1/inventory/{product_id}", response_model=InventoryItem)
def get_stock(product_id: str):
    """Get the current stock level for a product."""
    item = repository.get_stock(product_id)
    if item is None:
        raise HTTPException(status_code=404, detail="No inventory record for this product")
    return item


@app.post("/api/v1/inventory/{product_id}/reserve")
def reserve_stock(product_id: str, quantity: int):
    """Reserve stock for a product. Returns 409 if insufficient stock."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    try:
        return repository.reserve_stock(product_id, quantity)
    except ValueError as e:
        # Not enough stock — this is the "unavailable" response.
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/api/v1/inventory/{product_id}/release")
def release_stock(product_id: str, quantity: int):
    """Release previously reserved stock for a product."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    try:
        return repository.release_stock(product_id, quantity)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

@app.post("/api/v1/inventory/{product_id}/confirm")
def confirm_stock(product_id: str, quantity: int):
    """Confirm a sale — permanently remove reserved stock (payment succeeded)."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    try:
        return repository.confirm_stock(product_id, quantity)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

@app.post("/api/v1/inventory/{product_id}/add")
def add_stock(product_id: str, quantity: int):
    """Add stock (restock or create initial record)."""
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")
    return repository.add_stock(product_id, quantity)

handler = Mangum(app)