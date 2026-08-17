from fastapi import Depends, FastAPI, HTTPException, Response
from mangum import Mangum
from app.models import PaymentRequest, Payment
from app import repository
from fastapi.middleware.cors import CORSMiddleware
from app import config
from app.auth import require_admin
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
app = FastAPI(
    title="SmartRetailX - Payment Service",
    version="1.0.0",
    description="Payment service with PCI-scope-reduced tokenised charges and refunds"
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


@app.post("/api/v1/payments", response_model=Payment)
def create_payment(request: PaymentRequest, response: Response):
    """
    Charge a payment through the configured provider.

    Returns the Payment record either way, so the caller can see the
    failure_reason on a decline: 201 if the charge succeeded, 402 Payment
    Required if the provider declined it (a real and correct status here,
    not a generic 400).
    """
    payment = repository.charge(request.order_id, request.amount, request.payment_token)
    response.status_code = 201 if payment.status == "SUCCEEDED" else 402
    return payment


@app.get("/api/v1/payments/{payment_id}", response_model=Payment)
def get_payment(payment_id: str, _claims: dict = Depends(require_admin)):
    """Fetch a single payment by id."""
    payment = repository.get_payment(payment_id)
    if payment is None:
        raise HTTPException(status_code=404, detail="Payment not found")
    return payment


@app.post("/api/v1/payments/{payment_id}/refund", response_model=Payment)
def refund_payment(payment_id: str, _claims: dict = Depends(require_admin)):
    """
    Refund a previously succeeded payment. Idempotent — refunding an
    already-refunded payment returns 200 with the existing record rather
    than erroring.
    """
    try:
        payment = repository.refund(payment_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if payment is None:
        raise HTTPException(status_code=404, detail="Payment not found")
    return payment

handler = Mangum(app)
