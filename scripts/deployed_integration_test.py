"""Small, repeatable deployed API integration test.

This is intentionally an API test rather than a browser E2E or k6 workload.
It makes two controlled test orders at most (one COD success and one mock-card
decline), authenticates with dedicated Cognito test accounts, and exercises
the real API Gateway JWT authorizer and RBAC routes. It never prints tokens,
passwords, order IDs, or personal data.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib import error, parse, request

from deployed_api import DEFAULT_API_BASE_URL, normalise_api_base_url


# This fixture belongs to the deployed API integration test, not to a human
# catalogue administrator.
# It is reactivated for the test and deactivated again by the CD cleanup
# step. Keeping one identifiable fixture is safer than relying on a demo
# product somebody may edit or remove during normal manual testing.
FIXTURE_MARKER = "[SMARTRETAILX-INTEGRATION]:deployed-api-integration"
FIXTURE_PRODUCT = {
    "name": "SmartRetailX integration-test fixture",
    "description": FIXTURE_MARKER,
    "price": "1.00",
    "category": "Automated testing",
}
FIXTURE_STOCK_FLOOR = 10


class IntegrationFailure(RuntimeError):
    """A deployed behaviour did not match an integration-test expectation."""


def api_call(
    api_base_url: str,
    path: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    """Return both success and error responses so rejection checks are explicit."""
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")

    outgoing = request.Request(
        f"{normalise_api_base_url(api_base_url)}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with request.urlopen(outgoing, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return exc.code, raw
    except error.URLError as exc:
        raise IntegrationFailure(f"Could not reach the deployed API: {exc.reason}") from exc


def require_status(status: int, expected: int, check: str) -> None:
    if status != expected:
        raise IntegrationFailure(f"{check}: expected HTTP {expected}, received HTTP {status}.")


def find_fixture_product(api_base_url: str, admin_token: str) -> dict[str, Any] | None:
    """Find the test-owned product through the protected admin catalogue."""
    cursor: str | None = None
    for _ in range(20):
        path = "/api/v1/products/admin?limit=100"
        if cursor:
            path += f"&cursor={parse.quote(cursor, safe='')}"
        status, page = api_call(api_base_url, path, token=admin_token)
        require_status(status, 200, "admin catalogue read")
        for product in page.get("items", []):
            if FIXTURE_MARKER in product.get("description", ""):
                return product
        cursor = page.get("next_cursor")
        if not cursor:
            break
    return None


def ensure_fixture_product(api_base_url: str, admin_token: str) -> dict[str, Any]:
    """Create or reset the one test-owned product, then make it buyable."""
    product = find_fixture_product(api_base_url, admin_token)
    if product is None:
        status, product = api_call(
            api_base_url,
            "/api/v1/products",
            method="POST",
            token=admin_token,
            body=FIXTURE_PRODUCT,
        )
        require_status(status, 201, "create integration-test fixture product")
    else:
        status, product = api_call(
            api_base_url,
            f"/api/v1/products/{product['id']}",
            method="PUT",
            token=admin_token,
            body=FIXTURE_PRODUCT,
        )
        require_status(status, 200, "reset integration-test fixture product")

    if not product.get("active", True):
        status, product = api_call(
            api_base_url,
            f"/api/v1/products/{product['id']}/activate",
            method="PATCH",
            token=admin_token,
        )
        require_status(status, 200, "activate integration-test fixture product")

    return product


def ensure_fixture_stock(api_base_url: str, admin_token: str, product_id: str) -> None:
    """Give the isolated fixture enough stock without touching human products."""
    status, inventory = api_call(api_base_url, f"/api/v1/inventory/{product_id}")
    available = int(inventory.get("available_quantity", 0)) if status == 200 else 0
    if status not in (200, 404):
        raise IntegrationFailure(f"fixture inventory read: expected HTTP 200 or 404, received {status}.")
    if available >= FIXTURE_STOCK_FLOOR:
        return

    status, _ = api_call(
        api_base_url,
        f"/api/v1/inventory/{product_id}/add?quantity={FIXTURE_STOCK_FLOOR - available}",
        method="POST",
        token=admin_token,
    )
    require_status(status, 200, "prepare integration-test fixture stock")


def require_fixture_in_public_catalogue(api_base_url: str, product_id: str) -> None:
    """Check the active fixture is visible through the public paginated API."""
    cursor: str | None = None
    for _ in range(20):
        path = "/api/v1/products?limit=100"
        if cursor:
            path += f"&cursor={parse.quote(cursor, safe='')}"
        status, page = api_call(api_base_url, path)
        require_status(status, 200, "public catalogue read")
        if any(item.get("id") == product_id for item in page.get("items", [])):
            return
        cursor = page.get("next_cursor")
        if not cursor:
            break
    raise IntegrationFailure("Activated integration-test fixture product was absent from the public catalogue.")


def write_cleanup_manifest(path: str | None, manifest: dict[str, Any]) -> None:
    """Persist only IDs needed for CD's privileged test-data cleanup step."""
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest), encoding="utf-8")


def add_cleanup_order(manifest: dict[str, Any], order: dict[str, Any]) -> None:
    """Record new or reused test data immediately, so a failed run is cleaned too."""
    order_id = order.get("order_id")
    if not order_id:
        raise IntegrationFailure("Checkout response did not include an order ID.")
    if any(entry["order_id"] == order_id for entry in manifest["orders"]):
        return
    manifest["orders"].append({
        "order_id": order_id,
        "payment_id": order.get("payment_id"),
    })


def find_order_with_recipient(api_base_url: str, admin_token: str, recipient_name: str) -> dict[str, Any] | None:
    """Make a GitHub-run retry safe: re-use its existing test order if present."""
    cursor: str | None = None
    for _ in range(20):
        path = "/api/v1/orders/admin?limit=100"
        if cursor:
            path += f"&cursor={parse.quote(cursor, safe='')}"
        status, page = api_call(api_base_url, path, token=admin_token)
        require_status(status, 200, "admin order listing")
        for order in page.get("items", []):
            if order.get("shipping_address", {}).get("recipient_name") == recipient_name:
                return order
        cursor = page.get("next_cursor")
        if not cursor:
            return None
    raise IntegrationFailure("Admin order listing exceeded the safe pagination limit.")


def order_body(product: dict[str, Any], recipient_name: str, customer_email: str, *, declined: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "items": [{"product_id": product["id"], "quantity": 1, "expected_unit_price": product["price"]}],
        "shipping_address": {
            "recipient_name": recipient_name,
            "street": "1 Integration Test Street",
            "city": "Colombo",
            "postal_code": "00100",
            "country": "Sri Lanka",
        },
        "contact_email": customer_email,
        "contact_phone": "+94000000000",
        "payment_method": "card" if declined else "cash_on_delivery",
    }
    if declined:
        body["payment_token"] = "tok_test_decline"
    return body


def create_or_reuse_order(
    api_base_url: str,
    customer_token: str,
    admin_token: str,
    product: dict[str, Any],
    customer_email: str,
    recipient_name: str,
    *,
    declined: bool,
) -> tuple[dict[str, Any], bool]:
    existing = find_order_with_recipient(api_base_url, admin_token, recipient_name)
    if existing:
        return existing, False

    status, order = api_call(
        api_base_url,
        "/api/v1/orders",
        method="POST",
        token=customer_token,
        body=order_body(product, recipient_name, customer_email, declined=declined),
    )
    require_status(status, 201, "customer checkout")
    return order, True


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the deployed API integration suite.")
    parser.add_argument("--run-id", required=True, help="Stable CI run identifier, e.g. GitHub run ID.")
    parser.add_argument("--customer-email", required=True)
    parser.add_argument("--api-base", default=os.getenv("SMARTRETAILX_API_BASE_URL", DEFAULT_API_BASE_URL))
    parser.add_argument(
        "--cleanup-manifest",
        help="Path where CD can read the test-owned order/payment IDs for cleanup.",
    )
    args = parser.parse_args()

    customer_token = os.getenv("SMARTRETAILX_TEST_CUSTOMER_ID_TOKEN")
    admin_token = os.getenv("SMARTRETAILX_TEST_ADMIN_ID_TOKEN")
    if not customer_token or not admin_token:
        raise IntegrationFailure("Dedicated customer and admin ID tokens must be supplied through the environment.")

    api_base_url = normalise_api_base_url(args.api_base)
    run_marker = f"SmartRetailX Deployed API Integration {args.run_id}"
    cleanup_manifest: dict[str, Any] = {"fixture_product_id": None, "orders": []}
    write_cleanup_manifest(args.cleanup_manifest, cleanup_manifest)
    try:
        product = ensure_fixture_product(api_base_url, admin_token)
        cleanup_manifest["fixture_product_id"] = product["id"]
        write_cleanup_manifest(args.cleanup_manifest, cleanup_manifest)
        ensure_fixture_stock(api_base_url, admin_token, product["id"])

        # The public listing proves the fixture is actually sellable, not
        # merely visible to an administrator.
        require_fixture_in_public_catalogue(api_base_url, product["id"])

        status, _ = api_call(api_base_url, f"/api/v1/inventory/{product['id']}")
        require_status(status, 200, "public inventory read")

        status, _ = api_call(api_base_url, "/api/v1/orders/admin/summary", token=customer_token)
        if status not in (401, 403):
            raise IntegrationFailure("Customer was not rejected from the admin-only summary endpoint.")

        cod_order, cod_created = create_or_reuse_order(
            api_base_url,
            customer_token,
            admin_token,
            product,
            args.customer_email,
            f"{run_marker} COD",
            declined=False,
        )
        add_cleanup_order(cleanup_manifest, cod_order)
        write_cleanup_manifest(args.cleanup_manifest, cleanup_manifest)
        if cod_order.get("status") not in ("PENDING_ON_DELIVERY", "CONFIRMED"):
            raise IntegrationFailure("COD checkout did not produce a confirmed delivery order.")

        status, customer_order = api_call(api_base_url, f"/api/v1/orders/{cod_order['order_id']}", token=customer_token)
        require_status(status, 200, "customer reads own order")
        if customer_order.get("order_id") != cod_order.get("order_id"):
            raise IntegrationFailure("Customer order read returned an unexpected order.")

        status, updated_order = api_call(
            api_base_url,
            f"/api/v1/orders/{cod_order['order_id']}/delivery-status",
            method="PATCH",
            token=admin_token,
            body={"delivery_status": "PROCESSING"},
        )
        require_status(status, 200, "admin delivery update")
        if updated_order.get("delivery_status") != "PROCESSING":
            raise IntegrationFailure("Admin delivery update was not persisted.")

        # Only counterbalance stock on a newly created COD order. A rerun
        # reuses the same order and must not keep increasing stock.
        if cod_created:
            status, _ = api_call(
                api_base_url,
                f"/api/v1/inventory/{product['id']}/add?quantity=1",
                method="POST",
                token=admin_token,
            )
            require_status(status, 200, "admin stock update")

        declined_order, _ = create_or_reuse_order(
            api_base_url,
            customer_token,
            admin_token,
            product,
            args.customer_email,
            f"{run_marker} decline",
            declined=True,
        )
        add_cleanup_order(cleanup_manifest, declined_order)
        write_cleanup_manifest(args.cleanup_manifest, cleanup_manifest)
        if declined_order.get("status") != "FAILED":
            raise IntegrationFailure("Forced mock-card decline did not produce a FAILED order.")

        print("Deployed API integration test passed: public access, Cognito JWT/RBAC, COD, admin operations and forced decline verified.")
        return 0
    except IntegrationFailure as exc:
        print(f"Deployed API integration test failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
