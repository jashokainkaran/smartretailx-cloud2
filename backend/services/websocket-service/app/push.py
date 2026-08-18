import json
import logging

import boto3
from botocore.exceptions import ClientError

from app import config, repository

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_management_client = None


def _client():
    global _management_client
    if _management_client is None:
        _management_client = boto3.client(
            "apigatewaymanagementapi",
            region_name=config.AWS_REGION,
            endpoint_url=config.WEBSOCKET_MANAGEMENT_ENDPOINT,
        )
    return _management_client


def push_to_connections(connection_ids: list[str], payload: dict) -> None:
    """Best-effort, by design (see IMPLEMENTATION_RECORD.md's 2026-08-18
    WebSocket update): a failed push to one connection must not affect any
    other connection, and is never retried — the source of truth is already
    correct in DynamoDB regardless of whether this message arrives."""
    data = json.dumps(payload)
    for connection_id in connection_ids:
        try:
            _client().post_to_connection(ConnectionId=connection_id, Data=data)
        except ClientError as exc:
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if status == 410:
                # The client disconnected without a clean $disconnect ever
                # firing. Clean it up now rather than let it linger.
                repository.delete_connection(connection_id)
                logger.info("Stale connection removed connection_id=%s", connection_id)
            else:
                logger.error(
                    "Push failed connection_id=%s status=%s error=%s",
                    connection_id, status, exc,
                )
