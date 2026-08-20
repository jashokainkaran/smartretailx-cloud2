"""Place one deliberately controlled order against the deployed API.

This is a testing aid, not a bulk-order generator. It uses cash on delivery,
so it does not simulate or store a card number. Running with --confirm creates
real application data, events, e-mail attempts, and WebSocket updates.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from deployed_api import ApiError, DEFAULT_API_BASE_URL, prompt_for_id_token, request_json


SEED_MARKER = "[SMARTRETAILX-DEMO]"
LEDGER_PATH = Path(__file__).parent / ".seed-state" / "test-order-runs.json"


def get_seed_product(api_base_url: str, key: str) -> dict[str, Any]:
    """Find one active seed product using the public catalogue endpoint."""
    marker = f"{SEED_MARKER}:{key}"
    cursor: str | None = None
    while True:
        path = "/api/v1/products?limit=100"
        if cursor:
            path += f"&cursor={quote(cursor, safe='')}"
        _, page = request_json(api_base_url, path)
        for product in page["items"]:
            if marker in product.get("description", ""):
                return product
        cursor = page.get("next_cursor")
        if not cursor:
            raise RuntimeError(f"No active seeded product found for key '{key}'. Run seed_products.py first.")


def load_ledger() -> dict[str, Any]:
    if not LEDGER_PATH.exists():
        return {}
    try:
        return json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        raise RuntimeError(f"{LEDGER_PATH} is not valid JSON. Do not delete it until its entries are reviewed.") from None


def record_order(run_name: str, order: dict[str, Any]) -> None:
    ledger = load_ledger()
    ledger[run_name] = {
        "order_id": order["order_id"],
        "status": order["status"],
        "product_ids": [item["product_id"] for item in order["items"]],
    }
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Place one safe, traceable test order in the deployed SmartRetailX environment.")
    parser.add_argument("--run-name", required=True, help="A unique local label, e.g. cp048-cod-order-01.")
    parser.add_argument("--product-key", default="coffee", help="Seed fixture key to buy (default: coffee).")
    parser.add_argument("--quantity", type=int, default=1, help="Number of units to buy (default: 1).")
    parser.add_argument("--email", required=True, help="Recipient e-mail address for this test order.")
    parser.add_argument("--phone", required=True, help="Recipient phone number for this test order.")
    parser.add_argument("--recipient-name", default="SmartRetailX Test Customer")
    parser.add_argument("--street", default="1 Demo Street")
    parser.add_argument("--city", default="Colombo")
    parser.add_argument("--postal-code", default="00100")
    parser.add_argument("--country", default="Sri Lanka")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE_URL, help="Deployed API Gateway base URL.")
    parser.add_argument("--confirm", action="store_true", help="Actually create the order. Without it, this is a dry run.")
    args = parser.parse_args()

    if args.quantity < 1:
        parser.error("--quantity must be at least 1")

    try:
        ledger = load_ledger()
        if args.run_name in ledger:
            saved = ledger[args.run_name]
            print(f"No order created: run name '{args.run_name}' already recorded as {saved['order_id']} ({saved['status']}).")
            return 0

        product = get_seed_product(args.api_base, args.product_key)
        order_body = {
            "items": [{"product_id": product["id"], "quantity": args.quantity, "expected_unit_price": product["price"]}],
            "shipping_address": {"recipient_name": args.recipient_name, "street": args.street, "city": args.city, "postal_code": args.postal_code, "country": args.country},
            "contact_email": args.email,
            "contact_phone": args.phone,
            "payment_method": "cash_on_delivery",
        }
        print(f"Prepared COD order: {args.quantity} × {product['name']} at ${product['price']} each.")
        print(f"Run name: {args.run_name}. This avoids duplicate runs on this computer.")
        if not args.confirm:
            print("Dry run only — no order was created. Add --confirm when you are ready.")
            return 0

        token, claims = prompt_for_id_token()
        print(f"Customer token subject: {claims.get('email', claims.get('sub', 'unknown user'))}")
        _, order = request_json(args.api_base, "/api/v1/orders", method="POST", token=token, body=order_body)
        record_order(args.run_name, order)
        print(f"Created order {order['order_id']} with status {order['status']}.")
        return 0
    except (ApiError, RuntimeError, ValueError) as exc:
        print(f"Order test failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
