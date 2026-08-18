import os
import time

# Point the app at a SEPARATE test table BEFORE importing it — same pattern
# every other service's test file uses, and for the same reason: config.py
# reads these once at import time.
os.environ["CONNECTIONS_TABLE"] = "WebsocketConnectionsTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["COGNITO_USER_POOL_ID"] = "eu-west-1_testpool"
os.environ["COGNITO_CLIENT_ID"] = "test-client-id"
os.environ["WEBSOCKET_MANAGEMENT_ENDPOINT"] = "https://example.execute-api.eu-west-1.amazonaws.com/prod"

import boto3
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app import auth, config, repository
from app.connect import handler as connect_handler
from app.disconnect import handler as disconnect_handler
from app.push_consumer import handler as push_consumer_handler

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC_KEY = PRIVATE_KEY.public_key()


@pytest.fixture(autouse=True)
def test_table():
    """Create a clean WebsocketConnectionsTest table before each test."""
    dynamodb = boto3.resource(
        "dynamodb",
        endpoint_url=config.DYNAMODB_ENDPOINT,
        region_name=config.AWS_REGION,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    table = dynamodb.create_table(
        TableName="WebsocketConnectionsTest",
        KeySchema=[{"AttributeName": "connection_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "connection_id", "AttributeType": "S"},
            {"AttributeName": "role", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
        GlobalSecondaryIndexes=[{
            "IndexName": "role-index",
            "KeySchema": [{"AttributeName": "role", "KeyType": "HASH"}],
            "Projection": {"ProjectionType": "ALL"},
        }],
    )
    table.wait_until_exists()
    yield
    table.delete()
    table.wait_until_not_exists()


def make_token(overrides=None, exp_delta=3600):
    claims = {
        "sub": "user-1",
        "aud": config.COGNITO_CLIENT_ID,
        "iss": f"https://cognito-idp.{config.AWS_REGION}.amazonaws.com/{config.COGNITO_USER_POOL_ID}",
        "exp": int(time.time()) + exp_delta,
        "cognito:groups": ["customers"],
        "token_use": "id",
    }
    if overrides:
        claims.update(overrides)
    return jwt.encode(claims, PRIVATE_KEY, algorithm="RS256", headers={"kid": "test-key"})


class FakeSigningKey:
    key = PUBLIC_KEY


@pytest.fixture(autouse=True)
def fake_jwks(monkeypatch):
    """Skip the real network call to Cognito's JWKS endpoint — verify
    against the same key pair the test tokens were signed with instead."""
    class FakeJWKClient:
        def get_signing_key_from_jwt(self, token):
            return FakeSigningKey()

    monkeypatch.setattr(auth, "_jwks_client", FakeJWKClient())


# ---------------------------------------------------------------------------
# auth: token verification from scratch, not via API Gateway's authorizer
# ---------------------------------------------------------------------------

def test_verify_token_accepts_a_valid_token():
    claims = auth.verify_token(make_token())
    assert claims["sub"] == "user-1"


def test_verify_token_rejects_an_expired_token():
    with pytest.raises(jwt.PyJWTError):
        auth.verify_token(make_token(exp_delta=-10))


def test_verify_token_rejects_the_wrong_audience():
    with pytest.raises(jwt.PyJWTError):
        auth.verify_token(make_token({"aud": "some-other-client"}))


def test_verify_token_rejects_the_wrong_issuer():
    with pytest.raises(jwt.PyJWTError):
        auth.verify_token(make_token({"iss": "https://not-cognito.example.com"}))


def test_verify_token_rejects_an_access_token():
    """Cognito access tokens carry client_id, not aud, so this would likely
    already fail the audience check above — but that's an accident of
    Cognito's token shape, not something this code should rely on. The
    explicit token_use check catches it directly either way."""
    with pytest.raises(jwt.PyJWTError):
        auth.verify_token(make_token({"token_use": "access"}))


def test_role_from_claims_admin():
    assert auth.role_from_claims({"cognito:groups": ["admin", "customers"]}) == "admin"


def test_role_from_claims_customer():
    assert auth.role_from_claims({"cognito:groups": ["customers"]}) == "customer"


def test_role_from_claims_defaults_to_customer_with_no_groups():
    assert auth.role_from_claims({}) == "customer"


# ---------------------------------------------------------------------------
# repository: connection bookkeeping
# ---------------------------------------------------------------------------

def test_save_and_all_connections():
    repository.save_connection("conn-1", "user-1", "customer")
    repository.save_connection("conn-2", "user-2", "admin")
    assert set(repository.all_connections()) == {"conn-1", "conn-2"}


def test_admin_connections_excludes_customers():
    repository.save_connection("conn-1", "user-1", "customer")
    repository.save_connection("conn-2", "user-2", "admin")
    assert repository.admin_connections() == ["conn-2"]


def test_delete_connection_removes_it():
    repository.save_connection("conn-1", "user-1", "customer")
    repository.delete_connection("conn-1")
    assert repository.all_connections() == []


# ---------------------------------------------------------------------------
# connect / disconnect handlers
# ---------------------------------------------------------------------------

def connect_event(token=None):
    return {
        "requestContext": {"connectionId": "conn-1"},
        "queryStringParameters": {"token": token} if token else None,
    }


def test_connect_accepts_a_valid_token_and_saves_the_connection():
    result = connect_handler(connect_event(make_token({"cognito:groups": ["admin"]})), {})
    assert result["statusCode"] == 200
    assert repository.admin_connections() == ["conn-1"]


def test_connect_rejects_a_missing_token():
    result = connect_handler(connect_event(None), {})
    assert result["statusCode"] == 401
    assert repository.all_connections() == []


def test_connect_rejects_an_invalid_token():
    result = connect_handler(connect_event("not-a-real-token"), {})
    assert result["statusCode"] == 401
    assert repository.all_connections() == []


def test_disconnect_removes_the_connection():
    repository.save_connection("conn-1", "user-1", "customer")
    result = disconnect_handler({"requestContext": {"connectionId": "conn-1"}}, {})
    assert result["statusCode"] == 200
    assert repository.all_connections() == []


# ---------------------------------------------------------------------------
# push_consumer: routes each event type to the right audience
# ---------------------------------------------------------------------------

def sqs_event(detail_type, data):
    return {
        "Records": [{
            "body": __import__("json").dumps({
                "detail-type": detail_type,
                "detail": {"data": data},
            })
        }]
    }


def test_stock_level_changed_pushes_to_every_connection(monkeypatch):
    pushed = []
    monkeypatch.setattr(
        "app.push_consumer.push_to_connections",
        lambda ids, payload: pushed.append((ids, payload)),
    )
    repository.save_connection("conn-1", "user-1", "customer")
    repository.save_connection("conn-2", "user-2", "admin")

    result = push_consumer_handler(
        sqs_event("StockLevelChanged", {"product_id": "p1", "available": 5, "reserved": 2}),
        {},
    )

    assert result == {"pushed": 1}
    ids, payload = pushed[0]
    assert set(ids) == {"conn-1", "conn-2"}
    assert payload == {"type": "StockUpdated", "product_id": "p1", "available": 5, "reserved": 2}


def test_order_confirmed_pushes_to_admins_only(monkeypatch):
    pushed = []
    monkeypatch.setattr(
        "app.push_consumer.push_to_connections",
        lambda ids, payload: pushed.append((ids, payload)),
    )
    repository.save_connection("conn-1", "user-1", "customer")
    repository.save_connection("conn-2", "user-2", "admin")

    result = push_consumer_handler(
        sqs_event("OrderConfirmed", {
            "order_id": "order-1", "status": "CONFIRMED",
            "payment_method": "card", "reason": None,
        }),
        {},
    )

    assert result == {"pushed": 1}
    ids, payload = pushed[0]
    assert ids == ["conn-2"]
    assert payload == {
        "type": "OrderResolved", "order_id": "order-1",
        "status": "CONFIRMED", "payment_method": "card", "reason": None,
    }


def test_order_failed_pushes_to_admins_only(monkeypatch):
    pushed = []
    monkeypatch.setattr(
        "app.push_consumer.push_to_connections",
        lambda ids, payload: pushed.append((ids, payload)),
    )
    repository.save_connection("conn-1", "user-1", "customer")
    repository.save_connection("conn-2", "user-2", "admin")

    result = push_consumer_handler(
        sqs_event("OrderFailed", {
            "order_id": "order-2", "status": "REJECTED",
            "payment_method": "cash_on_delivery",
            "reason": "Insufficient stock for: p1",
        }),
        {},
    )

    assert result == {"pushed": 1}
    ids, payload = pushed[0]
    assert ids == ["conn-2"]
    assert payload["type"] == "OrderResolved"
    assert payload["status"] == "REJECTED"
    assert payload["reason"] == "Insufficient stock for: p1"


def test_order_needs_reconciliation_pushes_to_admins_only(monkeypatch):
    pushed = []
    monkeypatch.setattr(
        "app.push_consumer.push_to_connections",
        lambda ids, payload: pushed.append((ids, payload)),
    )
    repository.save_connection("conn-1", "user-1", "customer")
    repository.save_connection("conn-2", "user-2", "admin")

    result = push_consumer_handler(
        sqs_event("OrderNeedsReconciliation", {
            "order_id": "order-3",
            "reason": "payment declined (Card declined); stock release failed: timeout",
            "payment_id": "pay-x",
        }),
        {},
    )

    assert result == {"pushed": 1}
    ids, payload = pushed[0]
    assert ids == ["conn-2"]
    assert payload["type"] == "OrderNeedsReconciliation"
    assert payload["order_id"] == "order-3"


def test_unrecognised_detail_type_is_skipped_not_raised(monkeypatch):
    monkeypatch.setattr("app.push_consumer.push_to_connections", lambda ids, payload: None)
    result = push_consumer_handler(sqs_event("SomethingElse", {}), {})
    assert result == {"pushed": 0}
