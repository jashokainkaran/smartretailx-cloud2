"""Regression coverage for parsing the cognito:groups claim.

AUTH_TEST_MODE bypasses claims_from_request entirely with a hardcoded Python
list, so it never exercises the string shape API Gateway's HTTP API JWT
authorizer actually forwards for array-valued claims — which is why the
bracket-stripping bug here shipped to production undetected.
"""
import os

# Matches test_orders.py: config.py reads these once at import time, and
# pytest collects files alphabetically ("test_auth" before "test_orders"),
# so this file must set them too or it freezes app.config against the real
# (unset) environment before test_orders.py's own assignments ever run.
os.environ["ORDERS_TABLE"] = "OrdersTest"
os.environ["ORDER_OUTBOX_TABLE"] = "OrderOutboxTest"
os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"
os.environ["AUTH_TEST_MODE"] = "true"

from app.auth import groups


def test_single_group_forwarded_as_bracketed_string():
    # What API Gateway's JWT authorizer actually sends for one group.
    assert groups({"cognito:groups": "[customers]"}) == {"customers"}


def test_multiple_groups_forwarded_as_bracketed_string():
    assert groups({"cognito:groups": "[admin, customers]"}) == {"admin", "customers"}


def test_groups_as_real_list_still_works():
    assert groups({"cognito:groups": ["admin", "customers"]}) == {"admin", "customers"}


def test_missing_groups_claim_is_empty():
    assert groups({}) == set()
