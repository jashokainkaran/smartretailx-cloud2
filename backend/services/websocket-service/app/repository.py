import time

import boto3

from app import config

_dynamodb_kwargs = {"region_name": config.AWS_REGION}
if config.DYNAMODB_ENDPOINT:
    _dynamodb_kwargs.update({
        "endpoint_url": config.DYNAMODB_ENDPOINT,
        "aws_access_key_id": "local",
        "aws_secret_access_key": "local",
    })

dynamodb = boto3.resource("dynamodb", **_dynamodb_kwargs)
table = dynamodb.Table(config.CONNECTIONS_TABLE)

# Connections are cleaned up on a normal $disconnect, but a browser closing
# uncleanly means that may never fire. A week is generous enough that a
# genuinely active connection is never affected, but bounds how long a
# leaked row can linger.
CONNECTION_TTL_SECONDS = 7 * 24 * 60 * 60


def save_connection(connection_id: str, customer_id: str, role: str) -> None:
    table.put_item(Item={
        "connection_id": connection_id,
        "customer_id": customer_id,
        "role": role,
        "ttl": int(time.time()) + CONNECTION_TTL_SECONDS,
    })


def delete_connection(connection_id: str) -> None:
    table.delete_item(Key={"connection_id": connection_id})


def all_connections() -> list[str]:
    """Every open connection, regardless of role — safe for stock-level
    pushes, since that's public catalogue data, not anything customer- or
    admin-specific. A Scan is an accepted trade-off at this project's scale;
    a real high-traffic deployment would need a smarter fanout."""
    ids = []
    response = table.scan(ProjectionExpression="connection_id")
    ids.extend(item["connection_id"] for item in response["Items"])
    while "LastEvaluatedKey" in response:
        response = table.scan(
            ProjectionExpression="connection_id",
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        ids.extend(item["connection_id"] for item in response["Items"])
    return ids


def admin_connections() -> list[str]:
    """Only admin-tagged connections — the live order feed must never reach
    a customer connection."""
    ids = []
    response = table.query(
        IndexName="role-index",
        KeyConditionExpression="#r = :admin",
        ExpressionAttributeNames={"#r": "role"},
        ExpressionAttributeValues={":admin": "admin"},
        ProjectionExpression="connection_id",
    )
    ids.extend(item["connection_id"] for item in response["Items"])
    while "LastEvaluatedKey" in response:
        response = table.query(
            IndexName="role-index",
            KeyConditionExpression="#r = :admin",
            ExpressionAttributeNames={"#r": "role"},
            ExpressionAttributeValues={":admin": "admin"},
            ProjectionExpression="connection_id",
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        ids.extend(item["connection_id"] for item in response["Items"])
    return ids
