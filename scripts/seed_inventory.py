import sys, os
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "services", "inventory-service")
sys.path.insert(0, os.path.abspath(SERVICE_DIR))

from app import repository

# Put 100 units of one product in stock to test with.
repository.table.put_item(Item={
    "product_id": "test-product-1",
    "available_quantity": 100,
    "reserved_quantity": 0,
})
print("✅ Seeded test-product-1 with 100 units.")