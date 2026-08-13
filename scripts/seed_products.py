import sys, os
from decimal import Decimal
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "services", "product-service")
sys.path.insert(0, os.path.abspath(SERVICE_DIR))

from app.models import ProductCreate
from app import repository

for i in range(1, 56):
    repository.create_product(ProductCreate(
        name=f"Product {i}",
        description=f"Sample product number {i}",
        price=Decimal("9.99") + i,
        category="Electronics" if i % 2 == 0 else "Books",
    ))
print("✅ Seeded 55 products.")