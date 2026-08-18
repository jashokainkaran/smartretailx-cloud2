import logging

import jwt

from app import auth, repository

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def handler(event, context):
    """$connect route. A non-200 response here rejects the connection
    outright — this is the WebSocket equivalent of the JWT authorizer every
    HTTP route in this project already has, just done inline since WebSocket
    APIs have no per-message authorizer to lean on instead."""
    connection_id = event["requestContext"]["connectionId"]
    token = (event.get("queryStringParameters") or {}).get("token")

    if not token:
        logger.warning("Connect rejected — no token connection_id=%s", connection_id)
        return {"statusCode": 401, "body": "Missing token"}

    try:
        claims = auth.verify_token(token)
    except jwt.PyJWTError as exc:
        logger.warning("Connect rejected — invalid token connection_id=%s error=%s", connection_id, exc)
        return {"statusCode": 401, "body": "Invalid token"}

    role = auth.role_from_claims(claims)
    repository.save_connection(connection_id, claims["sub"], role)
    logger.info("Connected connection_id=%s role=%s", connection_id, role)
    return {"statusCode": 200}
