"""Create or update a curated ~50-item demo catalogue through the deployed API.

Run from the repository root:
    python scripts/seed_catalogue.py

Idempotent for its own fixtures: each one carries a stable marker in its
description. A later run finds that marker, updates the existing product
(including refreshing its image), and never creates a duplicate. Stock is
only created where no inventory record exists yet; a rerun never overwrites
stock an order has since changed.

Product photos are real, freely-usable images served directly from
Unsplash's own CDN (images.unsplash.com/photo-<id>) — every id below was
checked live before being included here. A handful of items are seeded with
deliberately low or zero stock so the low-stock and out-of-stock UI states
have something real to show, not just the happy path.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any
from urllib.parse import quote

from deployed_api import ApiError, DEFAULT_API_BASE_URL, prompt_for_id_token, request_json


SEED_MARKER = "[SMARTRETAILX-DEMO]"


def unsplash(photo_id: str) -> str:
    return f"https://images.unsplash.com/photo-{photo_id}?w=800&q=80&auto=format&fit=crop"


FIXTURES = [
    # --- Groceries ---
    {"key": "coffee", "name": "Highland Roast Coffee Beans", "description": "Medium roast whole coffee beans, sourced from single-origin farms.", "price": "12.99", "category": "Groceries", "stock": 40, "image": "1447933601403-0c6688de566e"},
    {"key": "tea", "name": "Ceylon Breakfast Tea", "description": "A bright, full-bodied loose-leaf black tea.", "price": "8.49", "category": "Groceries", "stock": 50, "image": "1571934811356-5cc061b6821f"},

    # --- Electronics ---
    {"key": "headphones", "name": "Wireless Studio Headphones", "description": "Comfortable over-ear Bluetooth headphones with active noise cancellation.", "price": "79.99", "category": "Electronics", "stock": 15, "image": "1505740420928-5e560c06d30e"},
    {"key": "speaker", "name": "Pocket Bluetooth Speaker", "description": "Compact rechargeable speaker for everyday listening.", "price": "34.50", "category": "Electronics", "stock": 20, "image": "1608043152269-423dbba4e7e1"},
    {"key": "mouse", "name": "Ergonomic Wireless Mouse", "description": "Silent-click wireless mouse with a contoured grip.", "price": "24.99", "category": "Electronics", "stock": 30, "image": "1527864550417-7fd91fc51a46"},
    {"key": "keyboard", "name": "Mechanical Keyboard", "description": "Tactile mechanical keyboard with per-key backlighting.", "price": "89.00", "category": "Electronics", "stock": 12, "image": "1587829741301-dc798b83add3"},
    {"key": "camera", "name": "Compact Mirrorless Camera", "description": "A lightweight mirrorless camera for everyday photography.", "price": "349.00", "category": "Electronics", "stock": 4, "image": "1526170375885-4d8ecf77b99f"},
    {"key": "laptop_stand", "name": "Adjustable Laptop Stand", "description": "Aluminium stand that raises a laptop to eye level.", "price": "39.00", "category": "Electronics", "stock": 25, "image": "1587614382346-4ec70e388b28"},
    {"key": "phone_case", "name": "Recycled Phone Case", "description": "Drop-tested phone case made from recycled ocean plastic.", "price": "19.99", "category": "Electronics", "stock": 60, "image": "1601593346740-925612772716"},

    # --- Home & Kitchen ---
    {"key": "lamp", "name": "Adjustable LED Desk Lamp", "description": "Dimmable desk lamp with a USB charging port.", "price": "45.00", "category": "Home & Kitchen", "stock": 12, "image": "1507473885765-e6ed057f782c"},
    {"key": "mug", "name": "Handmade Ceramic Mug", "description": "Stoneware mug, glazed and fired individually.", "price": "14.50", "category": "Home & Kitchen", "stock": 45, "image": "1514228742587-6b1558fcca3d"},
    {"key": "knife", "name": "Chef's Kitchen Knife", "description": "Forged high-carbon steel chef's knife.", "price": "42.00", "category": "Home & Kitchen", "stock": 18, "image": "1593618998160-e34014e67546"},
    {"key": "pan", "name": "Cast Iron Skillet", "description": "Pre-seasoned cast iron skillet for stovetop or oven.", "price": "38.00", "category": "Home & Kitchen", "stock": 10, "image": "1590794056226-79ef3a8147e1"},
    {"key": "board", "name": "Walnut Cutting Board", "description": "Solid walnut end-grain cutting board.", "price": "32.00", "category": "Home & Kitchen", "stock": 14, "image": "1611516491426-03025e6043c8"},
    {"key": "glasses", "name": "Crystal Wine Glasses (Set of 4)", "description": "Hand-blown crystal glasses for red or white wine.", "price": "44.00", "category": "Home & Kitchen", "stock": 16, "image": "1510812431401-41d2bd2722f3"},
    {"key": "shakers", "name": "Marble Salt & Pepper Set", "description": "A pair of marble salt and pepper shakers.", "price": "22.00", "category": "Home & Kitchen", "stock": 20, "image": "1596040033229-a9821ebd058d"},
    {"key": "travel_mug", "name": "Insulated Travel Mug", "description": "Vacuum-insulated mug that keeps drinks hot for six hours.", "price": "26.00", "category": "Home & Kitchen", "stock": 30, "image": "1509785307050-d4066910ec1e"},
    {"key": "espresso_cup", "name": "Espresso Cup Set", "description": "Double-walled glass espresso cups, set of two.", "price": "18.00", "category": "Home & Kitchen", "stock": 25, "image": "1521302080334-4bebac2763a6"},
    {"key": "frame", "name": "Oak Picture Frame", "description": "Solid oak picture frame, A4 size.", "price": "16.50", "category": "Home & Kitchen", "stock": 22, "image": "1513519245088-0e12902e5a38"},
    {"key": "clock", "name": "Minimalist Wall Clock", "description": "Silent-sweep wall clock with a walnut frame.", "price": "29.00", "category": "Home & Kitchen", "stock": 8, "image": "1495364141860-b0d03eccd065"},
    {"key": "books", "name": "Curated Coffee-Table Book Set", "description": "A set of three hardcover books on design and travel.", "price": "55.00", "category": "Home & Kitchen", "stock": 6, "image": "1512820790803-83ca734da794"},
    {"key": "bookend", "name": "Brass Bookends (Pair)", "description": "Solid brass geometric bookends.", "price": "28.00", "category": "Home & Kitchen", "stock": 15, "image": "1519791883288-dc8bd696e667"},
    {"key": "organizer", "name": "Bamboo Desk Organizer", "description": "Modular bamboo tray for desk accessories.", "price": "21.00", "category": "Home & Kitchen", "stock": 20, "image": "1544816155-12df9643f363"},

    # --- Outdoors & Travel ---
    {"key": "bottle", "name": "Insulated Water Bottle", "description": "Stainless steel bottle that keeps drinks cold for 24 hours.", "price": "22.00", "category": "Outdoors & Travel", "stock": 25, "image": "1602143407151-7111542de6e8"},
    {"key": "backpack", "name": "Canvas Everyday Backpack", "description": "Water-resistant canvas backpack with a padded laptop sleeve.", "price": "68.00", "category": "Outdoors & Travel", "stock": 12, "image": "1553062407-98eeb64c6a62"},
    {"key": "umbrella", "name": "Windproof Compact Umbrella", "description": "Auto-open umbrella built to withstand strong wind.", "price": "24.00", "category": "Outdoors & Travel", "stock": 30, "image": "1519677100203-a0e668c92439"},
    {"key": "yoga_mat", "name": "Non-Slip Yoga Mat", "description": "Extra-thick yoga mat with a textured, non-slip surface.", "price": "32.00", "category": "Outdoors & Travel", "stock": 20, "image": "1592432678016-e910b452f9a2"},
    {"key": "running_shoes", "name": "Lightweight Running Shoes", "description": "Breathable mesh running shoes with responsive cushioning.", "price": "89.99", "category": "Outdoors & Travel", "stock": 0, "image": "1542291026-7eec264c27ff"},
    {"key": "sneakers", "name": "Classic Canvas Sneakers", "description": "Everyday canvas sneakers with a rubber sole.", "price": "54.99", "category": "Outdoors & Travel", "stock": 18, "image": "1595950653106-6c9ebd614d3a"},

    # --- Accessories ---
    {"key": "sunglasses_aviator", "name": "Polarised Aviator Sunglasses", "description": "UV400 polarised lenses in a classic aviator frame.", "price": "39.00", "category": "Accessories", "stock": 25, "image": "1572635196237-14b3f281503f"},
    {"key": "sunglasses_round", "name": "Round Tortoiseshell Sunglasses", "description": "Acetate frame sunglasses with a tortoiseshell finish.", "price": "42.00", "category": "Accessories", "stock": 3, "image": "1511499767150-a48a237f0083"},
    {"key": "sunglasses_square", "name": "Retro Square Sunglasses", "description": "Bold square-frame sunglasses with UV protection.", "price": "36.00", "category": "Accessories", "stock": 20, "image": "1508296695146-257a814070b4"},
    {"key": "watch", "name": "Minimalist Leather Watch", "description": "Quartz watch with a genuine leather strap.", "price": "95.00", "category": "Accessories", "stock": 10, "image": "1524805444758-089113d48a6d"},
    {"key": "wallet", "name": "Leather Bifold Wallet", "description": "Full-grain leather wallet with six card slots.", "price": "48.00", "category": "Accessories", "stock": 22, "image": "1627123424574-724758594e93"},
    {"key": "scarf_wool", "name": "Wool Blend Scarf", "description": "Soft wool-blend scarf in a herringbone weave.", "price": "29.00", "category": "Accessories", "stock": 18, "image": "1520006403909-838d6b92c22e"},
    {"key": "scarf_silk", "name": "Silk Patterned Scarf", "description": "Lightweight silk scarf with a hand-finished edge.", "price": "34.00", "category": "Accessories", "stock": 15, "image": "1591047139829-d91aecb6caea"},
    {"key": "beanie", "name": "Ribbed Knit Beanie", "description": "Soft ribbed-knit beanie, one size fits most.", "price": "18.00", "category": "Accessories", "stock": 40, "image": "1576871337622-98d48d1cf531"},
    {"key": "gloves", "name": "Leather Gloves", "description": "Lined leather gloves for cold weather.", "price": "36.00", "category": "Accessories", "stock": 16, "image": "1512389142860-9c449e58a543"},
    {"key": "tote_canvas", "name": "Canvas Tote Bag", "description": "Heavyweight canvas tote with reinforced handles.", "price": "24.00", "category": "Accessories", "stock": 30, "image": "1591561954555-607968c989ab"},
    {"key": "tote_straw", "name": "Woven Straw Tote", "description": "Handwoven straw tote, lined with cotton.", "price": "38.00", "category": "Accessories", "stock": 2, "image": "1590874103328-eac38a683ce7"},

    # --- Apparel ---
    {"key": "jacket", "name": "Denim Jacket", "description": "Classic mid-wash denim jacket.", "price": "68.00", "category": "Apparel", "stock": 14, "image": "1551028719-00167b16eac5"},
    {"key": "boots", "name": "Leather Ankle Boots", "description": "Full-grain leather ankle boots with a stacked heel.", "price": "110.00", "category": "Apparel", "stock": 9, "image": "1543163521-1bf539c55dd2"},

    # --- Decor & Wellness ---
    {"key": "planter", "name": "Ceramic Plant Pot", "description": "Glazed ceramic pot with a drainage hole and saucer.", "price": "19.00", "category": "Decor & Wellness", "stock": 25, "image": "1485955900006-10f4d324d411"},
    {"key": "succulent_mini", "name": "Mini Succulent", "description": "A low-maintenance succulent in a 6cm pot.", "price": "9.00", "category": "Decor & Wellness", "stock": 50, "image": "1459156212016-c812468e2115"},
    {"key": "succulent_trio", "name": "Succulent Planter Trio", "description": "Three assorted succulents in matching planters.", "price": "26.00", "category": "Decor & Wellness", "stock": 20, "image": "1416879595882-3373a0480b5b"},
    {"key": "blanket", "name": "Chunky Knit Throw Blanket", "description": "Oversized chunky-knit throw for a sofa or bed.", "price": "58.00", "category": "Decor & Wellness", "stock": 12, "image": "1522708323590-d24dbb6b0267"},
    {"key": "candle", "name": "Scented Soy Candle", "description": "Hand-poured soy candle, 40-hour burn time.", "price": "21.00", "category": "Decor & Wellness", "stock": 35, "image": "1608571423902-eed4a5ad8108"},
]


def fixture_payload(fixture: dict[str, Any]) -> dict[str, Any]:
    """Return the exact product data expected by the Product API."""
    return {
        "name": fixture["name"],
        "description": f"{fixture['description']} {SEED_MARKER}:{fixture['key']}",
        "price": fixture["price"],
        "category": fixture["category"],
        "image_url": unsplash(fixture["image"]),
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


def ensure_stock(api_base_url: str, token: str, product_id: str, desired_stock: int) -> str:
    """Create stock only if none exists, preserving genuine order/stock history."""
    try:
        request_json(api_base_url, f"/api/v1/inventory/{quote(product_id, safe='')}", token=token)
        return "kept existing stock"
    except ApiError as exc:
        if "HTTP 404" not in str(exc):
            raise
    if desired_stock > 0:
        request_json(api_base_url, f"/api/v1/inventory/{quote(product_id, safe='')}/add?quantity={desired_stock}", method="POST", token=token)
        return f"created {desired_stock} units of stock"
    return "left at zero stock (deliberately out of stock)"


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

            stock_action = ensure_stock(args.api_base, token, product_id, fixture["stock"])
            print(f"{action:7} {fixture['key']:20} ({product_id}) — {stock_action}")

        print(f"Completed: {created} created, {updated} updated, {len(FIXTURES)} total. No duplicate demo products were made.")
        return 0
    except (ApiError, RuntimeError, ValueError) as exc:
        print(f"Seed failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
