from fastapi import FastAPI
from mangum import Mangum
from fastapi.middleware.cors import CORSMiddleware
from app import config
import logging

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


# TODO (yours, not mine):
#   POST /api/v1/orders            -> run the saga, return the Order
#   GET  /api/v1/orders/{order_id} -> fetch one order
#   GET  /api/v1/orders            -> list by customer_id via customer-orders-index
#   GET  /api/v1/orders/stuck      -> query the sparse saga-status GSI (admin)


# Same Mangum wrapper as every other service: identical code runs under
# uvicorn locally and as a Lambda in AWS (ADR-005).
handler = Mangum(app)
