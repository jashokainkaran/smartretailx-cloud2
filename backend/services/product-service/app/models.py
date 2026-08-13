from decimal import Decimal
from pydantic import BaseModel, Field
from typing import Optional


class ProductBase(BaseModel):
    name: str
    description: str
    price: Decimal = Field(..., gt=0, decimal_places=2)
    category: str
    image_url: Optional[str] = None


# What a client sends us when CREATING a product.
# It has the base fields but NOT an id — the server generates that.
class ProductCreate(ProductBase):
    pass


# What we STORE and SEND BACK — the base fields PLUS the id.
class Product(ProductBase):
    id: str


# The shape returned by the paginated list endpoint.
class ProductPage(BaseModel):
    items: list[Product]
    next_cursor: Optional[str] = None