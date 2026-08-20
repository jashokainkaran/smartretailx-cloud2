"""Create or update a small, recognisable demo catalogue through the deployed API.

Run from the repository root:
    python scripts/seed_products.py

The script is idempotent for its own fixture catalogue: each fixture has a
stable marker in its description. A later run finds that marker, updates the
existing product, and does not create a duplicate. It creates initial stock
only where an inventory record does not already exist; it never overwrites
stock after an order has changed it.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any
from urllib.parse import quote

from deployed_api import ApiError, DEFAULT_API_BASE_URL, prompt_for_id_token, request_json


SEED_MARKER = "[SMARTRETAILX-DEMO]"
FIXTURES = [
    {"key": "coffee", "name": "Highland Roast Coffee Beans", "description": "Medium roast whole coffee beans, 500 g.", "price": "12.99", "category": "Groceries", "stock": 40},
    {"key": "tea", "name": "Ceylon Breakfast Tea", "description": "A bright, full-bodied black tea, 100 bags.", "price": "8.49", "category": "Groceries", "stock": 50},
    {"key": "headphones", "name": "Wireless Studio Headphones", "description": "Comfortable over-ear Bluetooth headphones.", "price": "79.99", "category": "Electronics", "stock": 15},
    {"key": "speaker", "name": "Pocket Bluetooth Speaker", "description": "Compact rechargeable speaker for everyday listening.", "price": "34.50", "category": "Electronics", "stock": 20},
    {"key": "notebook", "name": "Hardcover Dot Grid Notebook", "description": "A5 notebook with 192 numbered pages.", "price": "9.95", "category": "Stationery", "stock": 30},
    {"key": "bottle", "name": "Insulated Water Bottle", "description": "Stainless steel bottle that keeps drinks cold for 24 hours.", "price": "22.00", "category": "Home", "stock": 25},
    {"key": "lamp", "name": "Adjustable LED Desk Lamp", "description": "Dimmable desk lamp with USB charging port.", "price": "45.00", "category": "Home", "stock": 12},
    {"key": "cable", "name": "Braided USB-C Cable", "description": "Durable one-metre USB-C charging cable.", "price": "11.25", "category": "Electronics", "stock": 60},
]


def fixture_payload(fixture: dict[str, Any]) -> dict[str, Any]:
    """Return the exact product data expected by the Product API."""
    return {
        "name": fixture["name"],
        "description": f"{fixture['description']} {SEED_MARKER}:{fixture['key']}",
        "price": fixture["price"],
        "category": fixture["category"],
    }


def get_all_admin_products(api_base_url: str, token: str) -> list[dict[str, Any]]:
    """Follow the cursor until every existing product is available for matching."""
    products: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        path = "/api/v1/products/admin?limit=100"
        if cursor:
            path += f"&cursor={quote(cursor, safe='')}"
        _, page = request_json(api_base_url, path, token=token)
        products.extend(page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return products


def find_existing(products: list[dict[str, Any]], fixture: dict[str, Any]) -> dict[str, Any] | None:
    marker = f"{SEED_MARKER}:{fixture['key']}"
    matches = [product for product in products if marker in product.get("description", "")]
    if len(matches) > 1:
        raise RuntimeError(f"More than one product has the seed marker {marker}. Resolve those duplicates manually before seeding again.")
    return matches[0] if matches else None


def ensure_initial_stock(api_base_url: str, token: str, product_id: str, desired_stock: int) -> str:
    """Create stock only if none exists, preserving genuine order/stock history."""
    try:
        request_json(api_base_url, f"/api/v1/inventory/{quote(product_id, safe='')}", token=token)
        return "kept existing stock"
    except ApiError as exc:
        if "HTTP 404" not in str(exc):
            raise
    request_json(api_base_url, f"/api/v1/inventory/{quote(product_id, safe='')}/add?quantity={desired_stock}", method="POST", token=token)
    return f"created {desired_stock} units of stock"


def main() -> int:
    parser = argparse.ArgumentParser(description="Idempotently seed the deployed SmartRetailX demo catalogue.")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE_URL, help="Deployed API Gateway base URL.")
    args = parser.parse_args()

    try:
        token, claims = prompt_for_id_token()
        print(f"Signed-in token subject: {claims.get('email', claims.get('sub', 'unknown user'))}")
        existing_products = get_all_admin_products(args.api_base, token)

        created = updated = 0
        for fixture in FIXTURES:
            product = find_existing(existing_products, fixture)
            payload = fixture_payload(fixture)
            if product:
                request_json(args.api_base, f"/api/v1/products/{quote(product['id'], safe='')}", method="PUT", token=token, body=payload)
                if not product.get("active", True):
                    request_json(args.api_base, f"/api/v1/products/{quote(product['id'], safe='')}/activate", method="PATCH", token=token)
                product_id = product["id"]
                updated += 1
                action = "updated"
            else:
                _, product = request_json(args.api_base, "/api/v1/products", method="POST", token=token, body=payload)
                product_id = product["id"]
                created += 1
                action = "created"

            stock_action = ensure_initial_stock(args.api_base, token, product_id, fixture["stock"])
            print(f"{action:7} {fixture['key']:12} ({product_id}) — {stock_action}")

        print(f"Completed: {created} created, {updated} updated. No duplicate demo products were made.")
        return 0
    except (ApiError, RuntimeError, ValueError) as exc:
        print(f"Seed failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
