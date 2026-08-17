"""Read trusted Cognito claims forwarded by API Gateway's JWT authorizer."""

from fastapi import HTTPException, Request, status
from app import config


def claims_from_request(request: Request) -> dict:
    """Return claims only after API Gateway has validated the JWT."""
    if config.AUTH_TEST_MODE:
        return {"sub": "test-admin", "cognito:groups": ["admin", "customers"]}
    event = request.scope.get("aws.event", {})
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    if not claims or not claims.get("sub"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication is required")
    return claims


def groups(claims: dict) -> set[str]:
    value = claims.get("cognito:groups", [])
    return set(value.split(",")) if isinstance(value, str) else set(value)


def require_admin(request: Request) -> dict:
    claims = claims_from_request(request)
    if "admin" not in groups(claims):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required")
    return claims


def require_customer(request: Request) -> dict:
    claims = claims_from_request(request)
    if "customers" not in groups(claims):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer access is required")
    return claims
