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


# What a client sends us when UPDATING a product. Every field is optional,
# so the client can send only what changed rather than resending the whole
# product (a partial update, not a full replace).
class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[Decimal] = Field(None, gt=0, decimal_places=2)
    category: Optional[str] = None
    image_url: Optional[str] = None


# What we STORE and SEND BACK — the base fields plus the id and active flag.
# `active` is server-controlled: clients never set it on creation.
class Product(ProductBase):
    id: str
    active: bool = True


# The shape returned by the paginated list endpoint.
class ProductPage(BaseModel):
    items: list[Product]
    next_cursor: Optional[str] = None