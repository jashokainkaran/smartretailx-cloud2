import os

# Comma-separated list of origins allowed to call this API (the frontend).
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "http://localhost:5173"
).split(",")

# Where DynamoDB lives. Locally this points at DynamoDB Local.
# In AWS we leave DYNAMODB_ENDPOINT unset, and boto3 finds real DynamoDB automatically.
DYNAMODB_ENDPOINT = os.environ.get("DYNAMODB_ENDPOINT")

# Which AWS region. Ireland, per our decision.
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")

# The name of our table.
ORDERS_TABLE = os.environ.get("ORDERS_TABLE", "Orders")

# The outbox table for order events (ADR-020). Terminal order states and
# their outgoing event are written in ONE transaction, so an order cannot
# reach CONFIRMED without its OrderConfirmed event being owed.
ORDER_OUTBOX_TABLE = os.environ.get("ORDER_OUTBOX_TABLE", "OrderOutbox")

# EventBridge bus for a best-effort OrderPlaced publish (CP-020) — separate
# from ORDER_OUTBOX_TABLE above: that transactional path is reserved for the
# saga's terminal events, where a lost event would be a real problem. A lost
# OrderPlaced only misses one live toast on the admin dashboard.
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME")

# The services the saga orchestrates (ADR-028). These are ENVIRONMENT
# CONFIGURATION, not constants: locally they are uvicorn on localhost, and
# once the APIs sit behind API Gateway they become HTTPS URLs. Hardcoding
# them would mean a code change to deploy, which is the thing environment
# variables exist to avoid.
#
# Contrast with EVENT_SOURCE in the outbox relay, which IS a module constant
# — that string is part of the event contract and is identical in every
# environment (ADR-021). A URL is not a contract; it is a location.
PRODUCT_SERVICE_URL = os.environ.get("PRODUCT_SERVICE_URL", "http://localhost:8080")
INVENTORY_SERVICE_URL = os.environ.get("INVENTORY_SERVICE_URL", "http://localhost:8081")
PAYMENT_SERVICE_URL = os.environ.get("PAYMENT_SERVICE_URL", "http://localhost:8082")

# How long to wait on a downstream service before giving up, in seconds.
# This matters more here than anywhere else in the system: a timeout on the
# payment call is exactly the case that produces an UNKNOWN payment
# (ADR-034), because we stop waiting without ever learning what happened.
# Too short and we manufacture UNKNOWNs that would have resolved; too long
# and the saga holds stock while a dead service never answers.
DOWNSTREAM_TIMEOUT_SECONDS = float(os.environ.get("DOWNSTREAM_TIMEOUT_SECONDS", "10"))

# In AWS the Order Lambda signs its service-to-service calls with its own
# temporary IAM role credentials. Local tests use ordinary localhost HTTP.
SIGN_DOWNSTREAM_REQUESTS = os.environ.get("SIGN_DOWNSTREAM_REQUESTS", "false").lower() == "true"

# Used only by isolated pytest runs, which do not have an API Gateway event.
AUTH_TEST_MODE = os.environ.get("AUTH_TEST_MODE", "false").lower() == "true"
