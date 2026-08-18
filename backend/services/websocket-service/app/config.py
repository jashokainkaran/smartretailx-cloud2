import os

# Which AWS region. Ireland, per our decision.
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")

# Where DynamoDB lives. Locally this points at DynamoDB Local.
DYNAMODB_ENDPOINT = os.environ.get("DYNAMODB_ENDPOINT")

# One connection per open browser tab, tagged with who it belongs to and
# whether they're an admin or a customer, so a push can be scoped correctly.
CONNECTIONS_TABLE = os.environ.get("CONNECTIONS_TABLE", "WebsocketConnections")

# Needed to verify a token ourselves — every other service in this project
# only ever reads claims API Gateway's own JWT authorizer already validated.
# A WebSocket connection has no per-message equivalent of that, so $connect
# has to do this verification from scratch, once, at connect time.
COGNITO_USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID")
COGNITO_CLIENT_ID = os.environ.get("COGNITO_CLIENT_ID")

# The base URL used to push a message to an open connection
# (https://{api-id}.execute-api.{region}.amazonaws.com/{stage}) — not the
# wss:// URL clients connect to, a different, AWS-internal "management" one.
WEBSOCKET_MANAGEMENT_ENDPOINT = os.environ.get("WEBSOCKET_MANAGEMENT_ENDPOINT")
