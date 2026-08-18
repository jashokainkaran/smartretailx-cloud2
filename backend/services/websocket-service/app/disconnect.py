import logging

from app import repository

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def handler(event, context):
    """$disconnect route. Always returns 200 — API Gateway does not retry a
    failed $disconnect the way it might a normal integration, so there is no
    benefit to signalling failure; a row that fails to delete here is still
    bounded by the connections table's own TTL."""
    connection_id = event["requestContext"]["connectionId"]
    repository.delete_connection(connection_id)
    logger.info("Disconnected connection_id=%s", connection_id)
    return {"statusCode": 200}
