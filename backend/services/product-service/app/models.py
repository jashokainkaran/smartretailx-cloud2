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


# Request body for the batch lookup used by the Order saga to resolve prices.
#
# max_length=100 is DynamoDB's BatchGetItem limit: 100 keys per request.
# The Order service caps a basket at 100 line items for the same underlying
# reason (its reserve transaction has a 100-operation limit), so the two
# ceilings line up rather than one silently truncating the other.
class ProductBatchRequest(BaseModel):
    product_ids: list[str] = Field(..., min_length=1, max_length=100)