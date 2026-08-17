"""Read trusted Cognito claims forwarded by API Gateway's JWT authorizer."""

from fastapi import HTTPException, Request, status
from app import config


def claims_from_request(request: Request) -> dict:
    """Return validated claims; never decode an unverified browser JWT here."""
    if config.AUTH_TEST_MODE:
        return {"sub": "test-admin", "cognito:groups": ["admin"]}
    event = request.scope.get("aws.event", {})
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    if not claims:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication is required")
    return claims


def groups(claims: dict) -> set[str]:
    value = claims.get("cognito:groups", [])
    # API Gateway's HTTP API JWT authorizer forwards array-valued claims as a
    # Python-repr-shaped string, e.g. "[customers]" or "[admin, customers]" —
    # not a clean CSV. A naive split(",") on a single group leaves the
    # brackets attached ("[customers]" != "customers"), so every real
    # single-group user fails require_customer/require_admin silently.
    if isinstance(value, str):
        return {group.strip() for group in value.strip("[]").split(",") if group.strip()}
    return set(value)


def require_admin(request: Request) -> dict:
    claims = claims_from_request(request)
    if "admin" not in groups(claims):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required")
    return claims
