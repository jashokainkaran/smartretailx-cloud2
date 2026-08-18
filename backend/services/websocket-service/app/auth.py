"""Verify a Cognito JWT from scratch.

Every other service in this project only ever reads claims API Gateway's own
JWT authorizer already validated (see e.g. order-service/app/auth.py). A
WebSocket connection has no equivalent authorizer type for this — the
verification has to happen here, once, at $connect.
"""

import jwt
from jwt import PyJWKClient

from app import config

_jwks_client: PyJWKClient | None = None


def _client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        jwks_url = (
            f"https://cognito-idp.{config.AWS_REGION}.amazonaws.com/"
            f"{config.COGNITO_USER_POOL_ID}/.well-known/jwks.json"
        )
        # PyJWKClient caches the fetched key set in memory for the life of
        # this Lambda's execution environment, so a warm invocation does not
        # refetch it on every connection.
        _jwks_client = PyJWKClient(jwks_url)
    return _jwks_client


def verify_token(token: str) -> dict:
    """Returns the token's claims if it is a genuinely valid, unexpired
    Cognito ID token for this user pool and this app client. Raises
    jwt.PyJWTError (or a subclass) on anything wrong with it — expiry
    included; PyJWT checks that by default during decode()."""
    signing_key = _client().get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience=config.COGNITO_CLIENT_ID,
        issuer=f"https://cognito-idp.{config.AWS_REGION}.amazonaws.com/{config.COGNITO_USER_POOL_ID}",
        options={"require": ["exp", "sub"]},
    )
    # An access token would already fail the audience check above (it
    # carries client_id, not aud), but that's an incidental side effect of
    # Cognito's own token shape, not something this code asserts on
    # purpose. Checking token_use directly means this stays correct even if
    # that shape ever changes, instead of relying on it by accident.
    if claims.get("token_use") != "id":
        raise jwt.InvalidTokenError("Expected a Cognito ID token")
    return claims


def role_from_claims(claims: dict) -> str:
    """'admin' or 'customer'. Unlike order-service's groups() helper, this
    reads cognito:groups straight from the token's own JSON payload — no
    bracket-stringified-array quirk here, since that's an artifact of how
    API Gateway's authorizer forwards claims, not of the token itself."""
    groups = claims.get("cognito:groups", [])
    return "admin" if "admin" in groups else "customer"
