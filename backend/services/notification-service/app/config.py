import os

# Which AWS region. Ireland, per our decision.
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")

# Where DynamoDB lives. Locally this points at DynamoDB Local.
DYNAMODB_ENDPOINT = os.environ.get("DYNAMODB_ENDPOINT")

# Idempotency table — records the event_id of every receipt this service
# has already sent, so a duplicate SQS delivery does not send it twice.
NOTIFICATIONS_TABLE = os.environ.get("NOTIFICATIONS_TABLE", "Notifications")

# The verified SES sender identity. Sending will fail with an SES error
# until this address is actually verified (see notification_service.tf).
SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
